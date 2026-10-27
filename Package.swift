// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "Anthora",
    platforms: [.macOS(.v14)],
    products: [
        .executable(name: "AnthoraLibraryManager", targets: ["AnthoraLibraryManager"]),
        .executable(name: "AnthoraMediaReader", targets: ["AnthoraMediaReader"]),
        .executable(name: "AnthoraPhotosBridge", targets: ["AnthoraPhotosBridge"]),
        .executable(name: "AnthoraApp", targets: ["AnthoraApp"]),
        .library(name: "LibraryCore", targets: ["LibraryCore"]),
        .library(name: "Scanner", targets: ["Scanner"]),
        .library(name: "ThumbnailEngine", targets: ["ThumbnailEngine"]),
    ],
    targets: [
        .target(name: "LibraryCore", exclude: ["Resources"]),
        .target(name: "Scanner", dependencies: ["LibraryCore"]),
        .target(name: "ThumbnailEngine", dependencies: ["LibraryCore"]),
        .executableTarget(
            name: "AnthoraLibraryManager",
            dependencies: ["LibraryCore", "Scanner", "ThumbnailEngine"],
            path: "Sources/AnthoraLibraryManager",
            linkerSettings: [.linkedFramework("Vision")]
        ),
        .executableTarget(
            name: "AnthoraMediaReader",
            dependencies: ["LibraryCore", "Scanner"],
            path: "Sources/AnthoraMediaReader",
            linkerSettings: [.linkedFramework("ImageIO"), .linkedFramework("UniformTypeIdentifiers"), .linkedFramework("CoreML"), .linkedFramework("AVFoundation"), .linkedFramework("Accelerate")]
        ),
        .executableTarget(
            name: "AnthoraPhotosBridge",
            path: "Sources/AnthoraPhotosBridge",
            exclude: ["Info.plist"],
            linkerSettings: [
                .linkedFramework("Photos"),
                .linkedFramework("AppKit"),
                .unsafeFlags([
                    "-Xlinker", "-sectcreate",
                    "-Xlinker", "__TEXT",
                    "-Xlinker", "__info_plist",
                    "-Xlinker", "Sources/AnthoraPhotosBridge/Info.plist",
                ]),
            ]
        ),
        .executableTarget(
            name: "AnthoraApp",
            dependencies: ["LibraryCore"],
            linkerSettings: [.linkedFramework("WebKit")]
        ),
        .testTarget(name: "LibraryCoreTests", dependencies: ["LibraryCore"]),
        .testTarget(name: "ScannerTests", dependencies: ["Scanner", "LibraryCore"]),
        .testTarget(name: "ThumbnailEngineTests", dependencies: ["ThumbnailEngine", "LibraryCore"]),
    ]
)
