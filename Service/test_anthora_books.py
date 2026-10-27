import unittest
import sqlite3
import json
import threading
import tempfile
import urllib.request
from http.server import HTTPServer
from pathlib import Path
from anthora_service import AnthoraHandler
from anthora_service import normalize_book, book_table

class BookTests(unittest.TestCase):
    def book(self):
        return {'id':'12345678-1234-1234-1234-123456789abc','template':'album','title':'Trip','pages':[{'id':'p1','layout':'single','caption':'Hello','photos':[{'id':7,'name':'Photo','contentUrl':'https://untrusted.invalid','fit':'fill'}]}]}
    def test_roundtrip_and_library_isolation(self):
        a,b=sqlite3.connect(':memory:'),sqlite3.connect(':memory:')
        for db in (a,b): book_table(db)
        book=normalize_book(self.book())
        a.execute('INSERT INTO anthora_books VALUES (?,?,?)',(book['id'],json.dumps(book),0))
        self.assertEqual(json.loads(a.execute('SELECT payload FROM anthora_books').fetchone()[0]),book)
        self.assertEqual(b.execute('SELECT COUNT(*) FROM anthora_books').fetchone()[0],0)
        self.assertNotIn('contentUrl',book['pages'][0]['photos'][0])
    def test_invalid_inputs(self):
        for value in (None,{}, {'id':'../../bad'}):
            with self.assertRaises(ValueError): normalize_book(value)
        for key,val in [('template','unknown'),('title',''),('pages',[]),('pages',[{}])]:
            book=self.book();book[key]=val
            with self.assertRaises(ValueError): normalize_book(book)
    def test_http_save_reopen_and_update(self):
        with tempfile.TemporaryDirectory() as folder:
            server = HTTPServer(('127.0.0.1', 0), AnthoraHandler)
            server.database = Path(folder) / 'test.sqlite'
            server.auth_token = None
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                url = 'http://127.0.0.1:%s/api/books' % server.server_port
                for title in ('First title', 'Updated title'):
                    book = self.book(); book['title'] = title
                    book['pages'][0]['photos'][0].update({'cropX':15,'cropY':80})
                    book.update(format='panorama', coverStyle='full', color='#123456')
                    request = urllib.request.Request(url, data=json.dumps(book).encode(), headers={'Content-Type':'application/json'})
                    with urllib.request.urlopen(request) as response: self.assertEqual(response.status, 200)
                with urllib.request.urlopen(url) as response: books = json.load(response)['books']
                self.assertEqual(len(books), 1)
                self.assertEqual(books[0]['title'], 'Updated title')
                self.assertEqual(books[0]['format'], 'panorama')
                self.assertEqual(books[0]['color'], '#123456')
                self.assertEqual(books[0]['coverStyle'], 'full')
                self.assertEqual(books[0]['pages'][0]['photos'][0]['cropX'],15)
                self.assertEqual(books[0]['pages'][0]['photos'][0]['cropY'],80)
                server.auth_token = 'book-test-secret'
                remove_url = url + '/' + book['id'] + '/remove'
                request = urllib.request.Request(remove_url, data=b'{}', headers={'Content-Type':'application/json'})
                with self.assertRaises(urllib.error.HTTPError) as denied: urllib.request.urlopen(request)
                self.assertEqual(denied.exception.code, 401)
                request.add_header('Authorization', 'Bearer book-test-secret')
                with urllib.request.urlopen(request) as response: self.assertTrue(json.load(response)['ok'])
                request = urllib.request.Request(url, headers={'Authorization':'Bearer book-test-secret'})
                with urllib.request.urlopen(request) as response: self.assertEqual(json.load(response)['books'], [])

            finally:
                server.shutdown(); server.server_close(); thread.join()

    def test_crop_coordinates_normalize_and_survive_storage(self):
        for value, expected in [(None,50), ('bad',50), (float('nan'),50), (float('inf'),50), (False,50), (-10,0), (120,100), (23.5,23.5)]:
            book=self.book();photo=book['pages'][0]['photos'][0];photo['cropX']=value;photo['cropY']=value
            result=normalize_book(book)['pages'][0]['photos'][0]
            self.assertEqual(result['cropX'],expected);self.assertEqual(result['cropY'],expected)

    def test_preserves_empty_spaces(self):
        book=self.book();book['pages'][0]['photos']=[None]
        self.assertEqual(normalize_book(book)['pages'][0]['photos'],[None])
    def test_all_designs_layouts_and_headings_roundtrip(self):
        for design in ('album','travel','wedding','valentine','baby','yearbook','birthday','portfolio'):
            book=self.book();book['template']=design;book['pages']=[]
            for layout,count in {'single':1,'portrait':1,'wide':1,'pair':2,'stacked':2,'triptych':3,'feature':3,'grid':4,'mosaic':6}.items():
                book['pages'].append({'id':layout,'layout':layout,'heading':'Our favorite days ♥','photos':[{'id':i+1} for i in range(count)]})
            result=normalize_book(book)
            self.assertEqual(result['template'],design)
            self.assertEqual(len(result['pages']),9)
            self.assertTrue(all(p['heading']=='Our favorite days ♥' for p in result['pages']))
            bad=self.book();bad['pages'][0]['heading']='x'*61
            with self.assertRaises(ValueError): normalize_book(bad)


class BookFormatTests(unittest.TestCase):
    book = BookTests.book
    def test_formats_covers_text_and_legacy_defaults(self):
        original=self.book()
        self.assertEqual(normalize_book(original)['format'],'square')
        self.assertEqual(normalize_book(original)['coverStyle'],'classic')
        for fmt in ('square','portrait','landscape','panorama','pocket','magazine'):
            for cover in ('classic','editorial','band','full','inset'):
                b=self.book();b.update(format=fmt,coverStyle=cover,template='vows')
                b['pages'].append({'id':'text','layout':'story','heading':'Our vows','text':'Words to remember.\nWith love.','photos':[]})
                normalized=normalize_book(b)
                self.assertEqual(normalized['format'],fmt)
                self.assertEqual(normalized['coverStyle'],cover)
                self.assertEqual(normalized['pages'][1]['text'],'Words to remember.\nWith love.')
        for key,value in [('format','invalid'),('coverStyle','invalid'),('color','red'),('color','#123'),('color',{})]:
            b=self.book();b[key]=value
            with self.assertRaises(ValueError):normalize_book(b)
        b=self.book();b['pages'][0]['text']='x'*1501
        with self.assertRaises(ValueError):normalize_book(b)
    def test_added_layouts_accept_exact_slot_counts(self):
        for layout,count in {'story':0,'offset':2,'columns':3,'hero':4,'contact':9}.items():
            b=self.book();b['pages'][0].update(layout=layout,photos=[None]*count)
            self.assertEqual(len(normalize_book(b)['pages'][0]['photos']),count)
            b['pages'][0]['photos'].append(None)
            with self.assertRaises(ValueError):normalize_book(b)

    def test_print_preview_is_bounded_and_regular_thumbnails_remain_small(self):
        from unittest.mock import Mock, patch
        from types import SimpleNamespace
        handler=object.__new__(AnthoraHandler)
        handler.server=SimpleNamespace(database='unused',mark_interactive_activity=Mock())
        handler.thumbnail=Mock(return_value=Path('/tmp/unused.jpg'))
        handler.send_file=Mock();handler.send_error=Mock()
        with patch('anthora_service.open_database') as database:
            row={'media_type':'image','modified_at':1}
            database.return_value.__enter__.return_value.execute.return_value.fetchone.return_value=row
            for kind,expected in [('thumbnail',1600),('book-preview',4800)]:
                handler.media(7,kind,{'size':['99999']})
                handler.thumbnail.assert_called_with(7,expected,1)
            row['media_type']='video';handler.thumbnail.reset_mock()
            handler.media(7,'book-preview',{'size':['3000']})
            handler.send_error.assert_called_with(400)
            handler.thumbnail.assert_not_called()

if __name__=='__main__': unittest.main()
