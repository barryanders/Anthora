"""Free feature access without contacting a licensing provider."""
import json
import sqlite3
import tempfile
import threading
import unittest
import urllib.request
import urllib.error
from pathlib import Path
from http.server import HTTPServer
from types import SimpleNamespace
from unittest.mock import patch, Mock
import anthora_service as service


class EditionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.database = self.root / 'library.sqlite'
        with sqlite3.connect(self.database) as db:
            db.executescript('''CREATE TABLE media_items(id INTEGER PRIMARY KEY,missing INTEGER DEFAULT 0,favorite INTEGER DEFAULT 0);
                CREATE TABLE libraries(id INTEGER PRIMARY KEY,scan_status TEXT,updated_at REAL);
                INSERT INTO libraries VALUES(1,'ready',0);''')
            db.executemany('INSERT INTO media_items(id) VALUES(?)', ((n,) for n in range(1,702)))
        self.environment = patch.dict(service.os.environ, {
            'ANTHORA_COMMERCIAL_BUILD':'1', 'ANTHORA_LICENSE_PATH':str(self.root/'license.json')})
        self.environment.start()
        self.server = HTTPServer(('127.0.0.1',0),service.AnthoraHandler)
        self.server.database = self.database
        self.server.auth_token = 'fixture-token'
        self.thread = threading.Thread(target=self.server.serve_forever,daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown(); self.server.server_close(); self.thread.join()
        self.environment.stop(); self.temp.cleanup()

    def request(self,path,body=None):
        data = json.dumps(body).encode() if body is not None else None
        req=urllib.request.Request(f'http://127.0.0.1:{self.server.server_port}'+path,data=data,
            headers={'Authorization':'Bearer fixture-token','Content-Type':'application/json'})
        try:
            with urllib.request.urlopen(req) as r:return r.status,json.load(r)
        except urllib.error.HTTPError as e:return e.code,json.load(e)

    def test_all_features_are_free_without_a_license(self):
        code,state=self.request('/api/license')
        self.assertEqual(code,200)
        self.assertEqual(state['features'],{'books':True,'cleanup':True})
        self.assertEqual(state['edition'],'free')
        self.assertIsNone(state['purchaseUrl'])
        self.assertFalse((self.root/'license.json').exists())

    def test_books_save_and_export_without_activation(self):
        book={'id':'12345678-1234-1234-1234-123456789abc','template':'vows','title':'Wedding',
            'format':'portrait','color':'#193b53','pages':[{'id':'p1','layout':'story','text':'Our vows','photos':[]}]}
        self.assertEqual(self.request('/api/books',book)[0],200)
        self.assertEqual(self.request('/api/books/export-check',{})[0],200)
        self.assertEqual(len(self.request('/api/books')[1]['books']),1)

    def test_legacy_activation_does_not_contact_a_provider(self):
        with patch.object(service.urllib.request,'urlopen',side_effect=AssertionError('unexpected network')):
            self.assertEqual(service.activate_license(self.database,'old-key'),{'licensed':True,'edition':'free'})
        self.assertFalse((self.root/'license.json').exists())

if __name__=='__main__':unittest.main()
