import Foundation
import Testing
@testable import LibraryCore

private func makeStore() throws -> LibraryStore {
    let directory = FileManager.default.temporaryDirectory
        .appendingPathComponent("AnthoraTests-\(UUID().uuidString)", isDirectory: true)
    return try LibraryStore(databaseURL: directory.appendingPathComponent("test.sqlite"))
}

private func sampleFile(folderID: Int64, path: String, type: MediaType) -> ScannedMediaFile {
    let url = URL(fileURLWithPath: path)
    return ScannedMediaFile(
        folderID: folderID,
        path: path,
        filename: url.lastPathComponent,
        ext: url.pathExtension.lowercased(),
        mediaType: type,
        sizeBytes: 1234,
        createdAt: Date(timeIntervalSince1970: 1_700_000_000),
        modifiedAt: Date(timeIntervalSince1970: 1_700_000_100),
        width: type == .image ? 800 : nil,
        height: type == .image ? 600 : nil
    )
}

@Suite struct LibraryStoreTests {
    @Test func accurateTextUpgradePreservesAndReindexesExistingText() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("AccurateOCRTest-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = try LibraryStore(databaseURL: directory.appendingPathComponent("test.sqlite"))
        let library = try await store.createLibrary(name: "Test", rootPath: "/tmp/r", bookmarkData: nil)
        let folderID = try await store.upsertFolder(libraryID: library.id, path: "/tmp/r", parentPath: nil, name: "r")
        try await store.upsertMediaItems([
            sampleFile(folderID: folderID, path: "/tmp/r/card.jpg", type: .image),
            sampleFile(folderID: folderID, path: "/tmp/r/movie.mp4", type: .video),
        ], libraryID: library.id)
        let item = try #require(try await store.items(matching: MediaQuery()).first { $0.mediaType == .image })
        try await store.saveTextAnalysis(itemID: item.id, modelVersion: "base-v1",
            result: TextAnalysisResult(observationCount: 1, textAreaRatio: 0.1, isTextHeavy: false, recognizedText: "Member"))
        #expect(try await store.imagesMissingAccurateText(modelVersion: "accurate-v1", limit: 8).map(\.id) == [item.id])
        try await store.saveAccurateText(itemID: item.id, modelVersion: "accurate-v1",
            result: TextAnalysisResult(observationCount: 1, textAreaRatio: 0.1, isTextHeavy: false, recognizedText: "9965"))
        #expect(try await store.ocrMediaIDs(matching: "9965") == [item.id])
        #expect(try await store.ocrMediaIDs(matching: "Member") == [item.id])
        #expect(try await store.imagesMissingAccurateText(modelVersion: "accurate-v1", limit: 8).isEmpty)
        #expect(try await store.imagesMissingAccurateText(modelVersion: "accurate-v2", limit: 8).map(\.id) == [item.id])
        try await store.saveAccurateText(itemID: item.id, modelVersion: "accurate-v2",
            result: TextAnalysisResult(observationCount: 0, textAreaRatio: 0, isTextHeavy: false, errorMessage: "Unreadable"))
        #expect(try await store.ocrMediaIDs(matching: "9965") == [item.id])
        #expect(try await store.imagesMissingAccurateText(modelVersion: "accurate-v2", limit: 8).isEmpty)
        try await store.saveTextAnalysis(itemID: item.id, modelVersion: "base-v2",
            result: TextAnalysisResult(observationCount: 1, textAreaRatio: 0.1, isTextHeavy: false, recognizedText: "Updated"))
        #expect(try await store.imagesMissingAccurateText(modelVersion: "accurate-v2", limit: 8).map(\.id) == [item.id])
    }

    @Test func faceSeedsAreBalancedAcrossPeople() async throws {
        let store = try makeStore()
        let library = try await store.createLibrary(name: "Test", rootPath: "/tmp/faces", bookmarkData: nil)
        let folderID = try await store.upsertFolder(libraryID: library.id, path: "/tmp/faces", parentPath: nil, name: "faces")
        let files = (0..<10).map {
            sampleFile(folderID: folderID, path: "/tmp/faces/a-\($0).jpg", type: .image)
        } + [sampleFile(folderID: folderID, path: "/tmp/faces/b.jpg", type: .image)]
        try await store.upsertMediaItems(files, libraryID: library.id)
        let items = try await store.items(matching: MediaQuery(sort: .nameAscending))
        for item in items {
            let key = item.filename == "b.jpg" ? "person_b" : "person_a"
            try await store.replaceFaceFeatures(
                itemID: item.id,
                personKey: key,
                features: [Data(repeating: UInt8(item.id % 255), count: 512 * MemoryLayout<Float>.size)]
            )
        }

        let seeds = try await store.seededFaceFeatures(limit: 2)
        #expect(Set(seeds.compactMap(\.personKey)) == ["person_a", "person_b"])
    }

    @Test func consolidatesOnlySeparateMachineGeneratedPeople() async throws {
        let store = try makeStore()
        let library = try await store.createLibrary(name: "Test", rootPath: "/tmp/faces", bookmarkData: nil)
        let folderID = try await store.upsertFolder(libraryID: library.id, path: "/tmp/faces", parentPath: nil, name: "faces")
        try await store.upsertMediaItems((0..<5).map {
            sampleFile(folderID: folderID, path: "/tmp/faces/\($0).jpg", type: .image)
        }, libraryID: library.id)
        let items = try await store.items(matching: MediaQuery(sort: .nameAscending))
        for item in items {
            try await store.replaceFaceFeatures(itemID: item.id, personKey: nil, features: [Data(repeating: 1, count: 2048)])
        }
        try await store.assignFaces(Array(try await store.unassignedFaceFeatures(limit: 3)), personKey: "person_a", distance: 0.1)
        try await store.assignFaces(Array(try await store.unassignedFaceFeatures(limit: 2)), personKey: "person_b", distance: 0.1)

        #expect(try await store.consolidateVisionPeople("person_a", "person_b") == "person_a")
        #expect(Set(try await store.seededFaceFeatures(limit: 10).compactMap(\.personKey)) == ["person_a"])
    }

    @Test func doesNotConsolidatePeopleSeenTogether() async throws {
        let store = try makeStore()
        let library = try await store.createLibrary(name: "Test", rootPath: "/tmp/faces", bookmarkData: nil)
        let folderID = try await store.upsertFolder(libraryID: library.id, path: "/tmp/faces", parentPath: nil, name: "faces")
        try await store.upsertMediaItems([
            sampleFile(folderID: folderID, path: "/tmp/faces/together.jpg", type: .image),
            sampleFile(folderID: folderID, path: "/tmp/faces/a.jpg", type: .image),
            sampleFile(folderID: folderID, path: "/tmp/faces/b.jpg", type: .image),
        ], libraryID: library.id)
        let items = try await store.items(matching: MediaQuery(sort: .nameAscending))
        let together = items.first { $0.filename == "together.jpg" }!
        try await store.replaceFaceFeatures(itemID: together.id, personKey: nil, features: [Data(repeating: 1, count: 2048), Data(repeating: 2, count: 2048)])
        for item in items where item.id != together.id {
            try await store.replaceFaceFeatures(itemID: item.id, personKey: nil, features: [Data(repeating: 3, count: 2048)])
        }
        let faces = try await store.unassignedFaceFeatures(limit: 10)
        let a = faces.filter { $0.faceIndex == 0 }
        let b = faces.filter { $0.faceIndex == 1 } + [faces.first { $0.mediaID != together.id }!]
        try await store.assignFaces(a, personKey: "person_a", distance: 0.1)
        try await store.assignFaces(b, personKey: "person_b", distance: 0.1)

        #expect(try await store.consolidateVisionPeople("person_a", "person_b") == nil)
    }

    @Test func confirmedPersonAbsorbsMachineGeneratedFragment() async throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("AnthoraTests-\(UUID().uuidString)", isDirectory: true)
        let databaseURL = directory.appendingPathComponent("test.sqlite")
        let store = try LibraryStore(databaseURL: databaseURL)
        let library = try await store.createLibrary(name: "Test", rootPath: "/tmp/faces", bookmarkData: nil)
        let folderID = try await store.upsertFolder(libraryID: library.id, path: "/tmp/faces", parentPath: nil, name: "faces")
        try await store.upsertMediaItems((0..<5).map {
            sampleFile(folderID: folderID, path: "/tmp/faces/named-\($0).jpg", type: .image)
        }, libraryID: library.id)
        let items = try await store.items(matching: MediaQuery(sort: .nameAscending))
        for item in items {
            try await store.replaceFaceFeatures(itemID: item.id, personKey: nil, features: [Data(repeating: 1, count: 2048)])
        }
        try await store.assignFaces(Array(try await store.unassignedFaceFeatures(limit: 3)), personKey: "person_israel", distance: 0.1)
        try await store.assignFaces(Array(try await store.unassignedFaceFeatures(limit: 2)), personKey: "person_fragment", distance: 0.1)
        let database = try Database(path: databaseURL.path)
        try database.run(
            "INSERT INTO people_aliases(source_key,target_key,display_name,updated_at) VALUES(?,?,?,?)",
            [.text("person_israel"), .text("person_israel"), .text("Israel"), .real(1)]
        )

        #expect(try await store.consolidateVisionPeople("person_israel", "person_fragment") == "person_israel")
        #expect(Set(try await store.seededFaceFeatures(limit: 10).compactMap(\.personKey)) == ["person_israel"])
    }

    @Test func doesNotAutomaticallyCombineTwoConfirmedPeople() async throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("AnthoraTests-\(UUID().uuidString)", isDirectory: true)
        let databaseURL = directory.appendingPathComponent("test.sqlite")
        let store = try LibraryStore(databaseURL: databaseURL)
        let library = try await store.createLibrary(name: "Test", rootPath: "/tmp/faces", bookmarkData: nil)
        let folderID = try await store.upsertFolder(libraryID: library.id, path: "/tmp/faces", parentPath: nil, name: "faces")
        try await store.upsertMediaItems((0..<4).map {
            sampleFile(folderID: folderID, path: "/tmp/faces/confirmed-\($0).jpg", type: .image)
        }, libraryID: library.id)
        let items = try await store.items(matching: MediaQuery(sort: .nameAscending))
        for item in items {
            try await store.replaceFaceFeatures(itemID: item.id, personKey: nil, features: [Data(repeating: 1, count: 2048)])
        }
        try await store.assignFaces(Array(try await store.unassignedFaceFeatures(limit: 2)), personKey: "person_a", distance: 0.1)
        try await store.assignFaces(Array(try await store.unassignedFaceFeatures(limit: 2)), personKey: "person_b", distance: 0.1)
        let database = try Database(path: databaseURL.path)
        try database.run(
            "INSERT INTO people_aliases(source_key,target_key,display_name,updated_at) VALUES(?,?,?,?)",
            [.text("person_a"), .text("person_a"), .text("Alex"), .real(1)]
        )
        try database.run(
            "INSERT INTO people_aliases(source_key,target_key,display_name,updated_at) VALUES(?,?,?,?)",
            [.text("person_b"), .text("person_b"), .text("Blair"), .real(1)]
        )

        #expect(try await store.consolidateVisionPeople("person_a", "person_b") == nil)
    }

    @Test func regroupingReopensOnlyUntouchedMachineGroups() async throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("AnthoraTests-\(UUID().uuidString)", isDirectory: true)
        let databaseURL = directory.appendingPathComponent("test.sqlite")
        let store = try LibraryStore(databaseURL: databaseURL)
        let library = try await store.createLibrary(name: "Test", rootPath: "/tmp/faces", bookmarkData: nil)
        let folderID = try await store.upsertFolder(libraryID: library.id, path: "/tmp/faces", parentPath: nil, name: "faces")
        try await store.upsertMediaItems((0..<6).map {
            sampleFile(folderID: folderID, path: "/tmp/faces/regroup-\($0).jpg", type: .image)
        }, libraryID: library.id)
        let items = try await store.items(matching: MediaQuery(sort: .nameAscending))
        for item in items {
            try await store.replaceFaceFeatures(itemID: item.id, personKey: nil, features: [Data(repeating: 1, count: 2048)])
        }
        try await store.assignFaces(Array(try await store.unassignedFaceFeatures(limit: 2)), personKey: "person_named", distance: 0.1)
        try await store.assignFaces(Array(try await store.unassignedFaceFeatures(limit: 2)), personKey: "person_machine", distance: 0.1)
        let remaining = try await store.unassignedFaceFeatures(limit: 10)
        try await store.assignFaces(remaining, personKey: "person_reviewed", distance: 0.1)
        let database = try Database(path: databaseURL.path)
        try database.run(
            "INSERT INTO people_aliases(source_key,target_key,display_name,updated_at) VALUES(?,?,?,?)",
            [.text("person_named"), .text("person_named"), .text("Israel"), .real(1)]
        )
        try database.run(
            "INSERT INTO media_profile_decisions(media_id,person_key,decision,updated_at) VALUES(?,?,?,?)",
            [.int(remaining[0].mediaID), .text("person_reviewed"), .text("associated"), .real(1)]
        )

        #expect(try await store.reopenMachineFaceGroupsForRegrouping() == 2)
        #expect(try await store.unassignedFaceFeatureCount() == 2)
        #expect(Set(try await store.seededFaceFeatures(limit: 10).compactMap(\.personKey)) == ["person_named", "person_reviewed"])
    }

    @Test func createLibraryAndFetch() async throws {
        let store = try makeStore()
        let library = try await store.createLibrary(name: "Test", rootPath: "/tmp/test-root", bookmarkData: nil)
        #expect(library.id > 0)

        let fetched = try await store.library(rootPath: "/tmp/test-root")
        #expect(fetched?.id == library.id)
        #expect(try await store.allLibraries().count == 1)
    }

    @Test func upsertItemsAndQueryByTypeAndFavorite() async throws {
        let store = try makeStore()
        let library = try await store.createLibrary(name: "Test", rootPath: "/tmp/r", bookmarkData: nil)
        let folderID = try await store.upsertFolder(libraryID: library.id, path: "/tmp/r", parentPath: nil, name: "r")

        try await store.upsertMediaItems([
            sampleFile(folderID: folderID, path: "/tmp/r/a.jpg", type: .image),
            sampleFile(folderID: folderID, path: "/tmp/r/b.mp4", type: .video),
        ], libraryID: library.id)

        #expect(try await store.itemCount(matching: MediaQuery(libraryID: library.id)) == 2)
        #expect(try await store.itemCount(matching: MediaQuery(libraryID: library.id, mediaType: .video)) == 1)

        // Upserting the same paths again must not create duplicates.
        try await store.upsertMediaItems([
            sampleFile(folderID: folderID, path: "/tmp/r/a.jpg", type: .image),
        ], libraryID: library.id)
        #expect(try await store.itemCount(matching: MediaQuery(libraryID: library.id)) == 2)

        let items = try await store.items(matching: MediaQuery(libraryID: library.id, sort: .nameAscending))
        #expect(items.map(\.filename) == ["a.jpg", "b.mp4"])
        #expect(items[0].width == 800)

        try await store.setFavorite(itemID: items[0].id, isFavorite: true)
        let favorites = try await store.items(matching: MediaQuery(favoritesOnly: true))
        #expect(favorites.map(\.filename) == ["a.jpg"])
    }

    @Test func searchByFilenameAndFolder() async throws {
        let store = try makeStore()
        let library = try await store.createLibrary(name: "Test", rootPath: "/tmp/r", bookmarkData: nil)
        let folderID = try await store.upsertFolder(libraryID: library.id, path: "/tmp/r", parentPath: nil, name: "r")
        try await store.upsertMediaItems([
            sampleFile(folderID: folderID, path: "/tmp/r/sunset-beach.jpg", type: .image),
            sampleFile(folderID: folderID, path: "/tmp/r/screenshot_01.png", type: .image),
        ], libraryID: library.id)

        #expect(try await store.itemCount(matching: MediaQuery(searchText: "sunset")) == 1)
        #expect(try await store.itemCount(matching: MediaQuery(searchText: "SCREEN")) == 1)
        #expect(try await store.itemCount(matching: MediaQuery(searchText: "100%")) == 0)
    }

    @Test func missingMarkingAndRevival() async throws {
        let store = try makeStore()
        let library = try await store.createLibrary(name: "Test", rootPath: "/tmp/r", bookmarkData: nil)
        let folderID = try await store.upsertFolder(libraryID: library.id, path: "/tmp/r", parentPath: nil, name: "r")
        try await store.upsertMediaItems([
            sampleFile(folderID: folderID, path: "/tmp/r/a.jpg", type: .image),
            sampleFile(folderID: folderID, path: "/tmp/r/b.jpg", type: .image),
        ], libraryID: library.id)

        // A scan that only re-sees one of the two items.
        let cutoff = Date()
        try await store.upsertMediaItems([
            sampleFile(folderID: folderID, path: "/tmp/r/a.jpg", type: .image),
        ], libraryID: library.id)
        let marked = try await store.markItemsMissing(libraryID: library.id, notSeenSince: cutoff)
        #expect(marked == 1)
        #expect(try await store.itemCount(matching: MediaQuery(libraryID: library.id)) == 1)
        #expect(try await store.itemCount(matching: MediaQuery(libraryID: library.id, includeMissing: true)) == 2)

        // Re-seeing the missing file revives it.
        try await store.upsertMediaItems([
            sampleFile(folderID: folderID, path: "/tmp/r/b.jpg", type: .image),
        ], libraryID: library.id)
        #expect(try await store.itemCount(matching: MediaQuery(libraryID: library.id)) == 2)
    }

    @Test func textAnalysisIsVersionedAndFilterable() async throws {
        let store = try makeStore()
        let library = try await store.createLibrary(name: "Test", rootPath: "/tmp/r", bookmarkData: nil)
        let folderID = try await store.upsertFolder(libraryID: library.id, path: "/tmp/r", parentPath: nil, name: "r")
        try await store.upsertMediaItems([
            sampleFile(folderID: folderID, path: "/tmp/r/post.png", type: .image),
            sampleFile(folderID: folderID, path: "/tmp/r/photo.jpg", type: .image),
            sampleFile(folderID: folderID, path: "/tmp/r/movie.mp4", type: .video),
        ], libraryID: library.id)

        let pending = try await store.unanalyzedImages(modelVersion: "ocr-v1", limit: 10)
        #expect(pending.map(\.filename).sorted() == ["photo.jpg", "post.png"])
        #expect(try await store.unanalyzedImageCount(modelVersion: "ocr-v1") == 2)
        #expect(try await store.unanalyzedMedia(modelVersion: "ocr-v1", limit: 10).count == 3)
        #expect(try await store.unanalyzedMediaCount(modelVersion: "ocr-v1") == 3)

        let post = try #require(pending.first(where: { $0.filename == "post.png" }))
        let photo = try #require(pending.first(where: { $0.filename == "photo.jpg" }))
        try await store.saveTextAnalysis(
            itemID: post.id,
            modelVersion: "ocr-v1",
            result: TextAnalysisResult(
                observationCount: 12,
                textAreaRatio: 0.4,
                isTextHeavy: true,
                recognizedText: "Costco receipt total"
            )
        )
        try await store.saveTextAnalysis(
            itemID: photo.id,
            modelVersion: "ocr-v1",
            result: TextAnalysisResult(observationCount: 0, textAreaRatio: 0, isTextHeavy: false)
        )

        #expect(try await store.itemCount(matching: MediaQuery(aiContentFilter: .textHeavy)) == 1)
        #expect(try await store.itemCount(matching: MediaQuery(aiContentFilter: .other)) == 1)
        #expect(try await store.itemCount(matching: MediaQuery(aiContentFilter: .unanalyzed)) == 0)
        #expect(try await store.unanalyzedImageCount(modelVersion: "ocr-v2") == 2)
        #expect(try await store.ocrMediaIDs(matching: "Costco").contains(post.id))
        #expect(try await store.hasSemanticEmbedding(itemID: post.id, modelVersion: "test-model") == false)
        try await store.saveSemanticEmbedding(
            itemID: post.id,
            modelVersion: "test-model",
            embedding: Data(repeating: 1, count: 16)
        )
        #expect(try await store.hasSemanticEmbedding(itemID: post.id, modelVersion: "test-model"))
    }

    @Test func secondaryPeopleAnalysisOnlySelectsAmbiguousCandidates() async throws {
        let store = try makeStore()
        let library = try await store.createLibrary(name: "Test", rootPath: "/tmp/r", bookmarkData: nil)
        let folderID = try await store.upsertFolder(libraryID: library.id, path: "/tmp/r", parentPath: nil, name: "r")
        try await store.upsertMediaItems([
            sampleFile(folderID: folderID, path: "/tmp/r/ambiguous.jpg", type: .image),
            sampleFile(folderID: folderID, path: "/tmp/r/body.jpg", type: .image),
            sampleFile(folderID: folderID, path: "/tmp/r/plain.jpg", type: .image),
        ], libraryID: library.id)
        let items = try await store.items(matching: MediaQuery(sort: .nameAscending))
        for item in items {
            try await store.saveFaceAnalysis(itemID: item.id, boxesJSON: "[]", count: 0)
            try await store.savePersonAnalysis(itemID: item.id, count: item.filename == "body.jpg" ? 1 : 0)
        }
        let ambiguous = try #require(items.first(where: { $0.filename == "ambiguous.jpg" }))
        try await store.replaceVisionLabels(itemID: ambiguous.id, labels: [("people", 0.91)])

        let pending = try await store.imagesNeedingSecondaryPeopleAnalysis(modelVersion: "florence-v1", limit: 10)
        #expect(pending.map(\.filename) == ["ambiguous.jpg"])

        try await store.saveSecondaryPeopleAnalysis(
            itemID: ambiguous.id,
            modelVersion: "florence-v1",
            personDetected: false,
            tokenCount: 12
        )
        #expect(try await store.imagesNeedingSecondaryPeopleAnalysis(modelVersion: "florence-v1", limit: 10).isEmpty)
        #expect(try await store.imagesNeedingSecondaryPeopleAnalysis(modelVersion: "florence-v2", limit: 10).map(\.filename) == ["ambiguous.jpg"])
    }

    @Test func folderSubtreeQuery() async throws {
        let store = try makeStore()
        let library = try await store.createLibrary(name: "Test", rootPath: "/tmp/r", bookmarkData: nil)
        let rootID = try await store.upsertFolder(libraryID: library.id, path: "/tmp/r", parentPath: nil, name: "r")
        let tripsID = try await store.upsertFolder(libraryID: library.id, path: "/tmp/r/trips", parentPath: "/tmp/r", name: "trips")
        let osloID = try await store.upsertFolder(libraryID: library.id, path: "/tmp/r/trips/oslo", parentPath: "/tmp/r/trips", name: "oslo")
        // Sibling whose name shares the subtree prefix — must NOT match /tmp/r/trips.
        let trapID = try await store.upsertFolder(libraryID: library.id, path: "/tmp/r/trips-old", parentPath: "/tmp/r", name: "trips-old")

        try await store.upsertMediaItems([
            sampleFile(folderID: rootID, path: "/tmp/r/top.jpg", type: .image),
            sampleFile(folderID: tripsID, path: "/tmp/r/trips/ferry.jpg", type: .image),
            sampleFile(folderID: osloID, path: "/tmp/r/trips/oslo/fjord.jpg", type: .image),
            sampleFile(folderID: trapID, path: "/tmp/r/trips-old/relic.jpg", type: .image),
        ], libraryID: library.id)

        let subtree = try await store.items(
            matching: MediaQuery(folderSubtreePath: "/tmp/r/trips", sort: .nameAscending)
        )
        #expect(subtree.map(\.filename) == ["ferry.jpg", "fjord.jpg"])
        #expect(try await store.itemCount(matching: MediaQuery(folderSubtreePath: "/tmp/r")) == 4)
    }

    @Test func folderCoversPreferManualChoiceAndCountSubtree() async throws {
        let store = try makeStore()
        let library = try await store.createLibrary(name: "Test", rootPath: "/tmp/r", bookmarkData: nil)
        let profileID = try await store.upsertFolder(
            libraryID: library.id,
            path: "/tmp/r/profile",
            parentPath: "/tmp/r",
            name: "profile"
        )
        let mediaID = try await store.upsertFolder(
            libraryID: library.id,
            path: "/tmp/r/profile/media",
            parentPath: "/tmp/r/profile",
            name: "media"
        )
        try await store.upsertMediaItems([
            sampleFile(folderID: mediaID, path: "/tmp/r/profile/media/small.jpg", type: .image),
            sampleFile(folderID: mediaID, path: "/tmp/r/profile/media/large.jpg", type: .image),
        ], libraryID: library.id)

        let children = try await store.childFolders(libraryID: library.id, parentPath: "/tmp/r")
        #expect(children.map(\.id) == [profileID])
        #expect(try await store.folderSubtreeItemCount(folderID: profileID) == 2)

        let items = try await store.items(matching: MediaQuery(sort: .nameAscending))
        let small = try #require(items.first(where: { $0.filename == "small.jpg" }))
        try await store.setFolderCover(folderID: profileID, mediaItemID: small.id)
        #expect(try await store.folderCoverItem(folderID: profileID)?.id == small.id)

        try await store.setFolderCover(folderID: profileID, mediaItemID: nil)
        #expect(try await store.folderCoverItem(folderID: profileID) != nil)
    }

    @Test func collectionsLifecycle() async throws {
        let store = try makeStore()
        let library = try await store.createLibrary(name: "Test", rootPath: "/tmp/r", bookmarkData: nil)
        let folderID = try await store.upsertFolder(libraryID: library.id, path: "/tmp/r", parentPath: nil, name: "r")
        try await store.upsertMediaItems([
            sampleFile(folderID: folderID, path: "/tmp/r/a.jpg", type: .image),
            sampleFile(folderID: folderID, path: "/tmp/r/b.jpg", type: .image),
        ], libraryID: library.id)
        let items = try await store.items(matching: MediaQuery(sort: .nameAscending))

        let collection = try await store.createCollection(name: "Best Of")
        try await store.addItems([items[0].id], toCollection: collection.id)
        // Adding the same item twice is a no-op, not an error.
        try await store.addItems([items[0].id], toCollection: collection.id)

        var fetched = try await store.allCollections()
        #expect(fetched.map(\.name) == ["Best Of"])
        #expect(fetched[0].itemCount == 1)

        let members = try await store.items(matching: MediaQuery(collectionID: collection.id))
        #expect(members.map(\.filename) == ["a.jpg"])

        try await store.renameCollection(id: collection.id, name: "Selects")
        try await store.removeItem(items[0].id, fromCollection: collection.id)
        fetched = try await store.allCollections()
        #expect(fetched.map(\.name) == ["Selects"])
        #expect(fetched[0].itemCount == 0)

        // Deleting a collection never deletes media items.
        try await store.deleteCollection(id: collection.id)
        #expect(try await store.allCollections().isEmpty)
        #expect(try await store.itemCount(matching: MediaQuery(libraryID: library.id)) == 2)
    }

    @Test func folderCountsAndCascadingRemoval() async throws {
        let store = try makeStore()
        let library = try await store.createLibrary(name: "Test", rootPath: "/tmp/r", bookmarkData: nil)
        let folderID = try await store.upsertFolder(libraryID: library.id, path: "/tmp/r", parentPath: nil, name: "r")
        try await store.upsertMediaItems([
            sampleFile(folderID: folderID, path: "/tmp/r/a.jpg", type: .image),
        ], libraryID: library.id)
        try await store.recomputeFolderItemCounts(libraryID: library.id)
        #expect(try await store.folders(libraryID: library.id).first?.itemCount == 1)

        try await store.removeLibrary(id: library.id)
        #expect(try await store.allLibraries().isEmpty)
        #expect(try await store.itemCount(matching: MediaQuery(includeMissing: true)) == 0)
    }

    @Test func consolidationKeepsOnlyExplicitCrossProfileReferences() async throws {
        let store = try makeStore()
        let library = try await store.createLibrary(name: "Test", rootPath: "/tmp/r", bookmarkData: nil)
        let aliceID = try await store.upsertFolder(libraryID: library.id, path: "/tmp/r/People/alice", parentPath: "/tmp/r/People", name: "alice")
        let bobID = try await store.upsertFolder(libraryID: library.id, path: "/tmp/r/People/bob", parentPath: "/tmp/r/People", name: "bob")
        try await store.upsertMediaItems([
            sampleFile(folderID: aliceID, path: "/tmp/r/People/alice/keeper.jpg", type: .image),
            sampleFile(folderID: aliceID, path: "/tmp/r/People/alice/redundant.jpg", type: .image),
        ], libraryID: library.id)
        let items = try await store.items(matching: MediaQuery(libraryID: library.id, sort: .nameAscending))
        let keeper = try #require(items.first(where: { $0.filename == "keeper.jpg" }))
        let redundant = try #require(items.first(where: { $0.filename == "redundant.jpg" }))
        try await store.replaceMediaReferences(libraryID: library.id, references: [
            MediaReferenceInput(path: "/tmp/r/People/alice/same.jpg", targetPath: redundant.path, folderPath: "/tmp/r/People/alice"),
        ])

        try await store.consolidateExactDuplicate(
            keepID: keeper.id,
            removeID: redundant.id,
            preservedReferences: [("/tmp/r/People/bob/shared.jpg", bobID)]
        )

        #expect(try await store.item(id: redundant.id) == nil)
        let references = try await store.referenceLocations(itemID: keeper.id)
        #expect(references.count == 1)
        #expect(references.first?.path == "/tmp/r/People/bob/shared.jpg")
    }

    @Test func failedVideoFingerprintsRetryAfterBackoff() async throws {
        let store = try makeStore()
        let library = try await store.createLibrary(name: "Test", rootPath: "/tmp/r", bookmarkData: nil)
        let folderID = try await store.upsertFolder(libraryID: library.id, path: "/tmp/r", parentPath: nil, name: "r")
        try await store.upsertMediaItems([
            sampleFile(folderID: folderID, path: "/tmp/r/clip.mp4", type: .video),
        ], libraryID: library.id)
        let item = try #require(try await store.items(matching: MediaQuery(libraryID: library.id)).first)
        try await store.saveVideoMetadata(
            itemID: item.id,
            width: 720,
            height: 1280,
            durationSeconds: 10,
            frameRate: 30
        )

        #expect(try await store.videosMissingFingerprint(modelVersion: "video-v1", limit: 10).map(\.id) == [item.id])
        try await store.saveVideoFingerprint(
            itemID: item.id,
            modelVersion: "video-v1",
            durationSeconds: 10,
            samplesJSON: "[]",
            errorMessage: "temporary decode failure"
        )
        #expect(try await store.videosMissingFingerprint(modelVersion: "video-v1", limit: 10).isEmpty)
        #expect(try await store.videosMissingFingerprint(
            modelVersion: "video-v1",
            limit: 10,
            retryFailuresAfter: 0
        ).map(\.id) == [item.id])

        try await store.saveVideoFingerprint(
            itemID: item.id,
            modelVersion: "video-v1",
            durationSeconds: 10,
            samplesJSON: "[{\"time\":1,\"hash\":\"abc\"},{\"time\":2,\"hash\":\"def\"}]"
        )
        #expect(try await store.videosMissingFingerprint(
            modelVersion: "video-v1",
            limit: 10,
            retryFailuresAfter: 0
        ).isEmpty)
    }

    @Test func recoveredMediaInvalidatesDerivedAnalysis() async throws {
        let store = try makeStore()
        let library = try await store.createLibrary(name: "Test", rootPath: "/tmp/r", bookmarkData: nil)
        let folderID = try await store.upsertFolder(libraryID: library.id, path: "/tmp/r", parentPath: nil, name: "r")
        try await store.upsertMediaItems([
            sampleFile(folderID: folderID, path: "/tmp/r/broken.mp4", type: .video),
        ], libraryID: library.id)
        let item = try #require(try await store.items(matching: MediaQuery(libraryID: library.id)).first)
        try await store.saveTextAnalysis(
            itemID: item.id,
            modelVersion: "test-v1",
            result: TextAnalysisResult(
                observationCount: 0,
                textAreaRatio: 0,
                isTextHeavy: false,
                errorMessage: "decode failed"
            )
        )
        try await store.savePersonAnalysis(itemID: item.id, count: -1)
        try await store.saveSemanticEmbedding(itemID: item.id, modelVersion: "test-v1", embedding: Data(repeating: 1, count: 16))

        try await store.completeRecoveredMedia(
            itemID: item.id,
            sizeBytes: 9_876,
            modifiedAt: Date(timeIntervalSince1970: 1_800_000_000)
        )

        let recovered = try #require(try await store.item(id: item.id))
        #expect(recovered.sizeBytes == 9_876)
        #expect(try await store.unanalyzedMedia(modelVersion: "test-v1", limit: 10).map(\.id) == [item.id])
    }
}
