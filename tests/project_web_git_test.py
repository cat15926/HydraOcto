import importlib.util
import hashlib
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

SCRIPTS = Path(__file__).resolve().parents[1] / 'scripts/runtime'


def module(name):
    spec = importlib.util.spec_from_file_location(name, SCRIPTS / (name + '.py'))
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


web = module('project-web')
delivery = module('project-git')


class PublicSources(unittest.TestCase):
    def test_transient_read_rechecks_the_public_url_once(self):
        url = 'https://a.example/doc'
        page = (url, 'text/plain', 'Document')
        with patch.object(web, 'fetch_once', side_effect=[TimeoutError(), page]) as fetch:
            self.assertEqual(web.fetch(url), page)
            self.assertEqual([c.args for c in fetch.call_args_list], [(url, 0), (url, 1)])
        with patch.object(web, 'fetch_once', side_effect=web.Unavailable('restricted')) as fetch:
            with self.assertRaises(web.Unavailable):
                web.fetch(url)
            fetch.assert_called_once_with(url, 0)

    def test_read_body_offsets_and_search_snippets(self):
        with patch.object(web, 'fetch', return_value=('https://a.example/doc','text/html','<html><head><title>Manual</title></head><body><script>hidden</script><p>Unique fact</p></body></html>')):
            result = web.run('read', {'url':'https://a.example/doc','offset':2})
            self.assertEqual(result['text'], 'ique fact')
            self.assertEqual(result['title'], 'Manual')
        with patch.object(web, 'fetch', return_value=('https://www.bing.com/search','text/xml','<rss><channel><item><title>A</title><link>https://a.example/doc</link><description>hint</description></item></channel></rss>')):
            result = web.run('search', {'query':'finding'})
            self.assertEqual(result['results'][0]['url'], 'https://a.example/doc')
            self.assertNotIn('text',result['results'][0])

    def test_non_public_targets_are_rejected_before_connect(self):
        for url in ['file:///tmp/data', 'http://localhost/a', 'https://user:password@example.org', 'http://example.org:22']:
            with self.subTest(url=url), self.assertRaises(ValueError):
                web.public_url(url)
        with patch.object(web.socket,'getaddrinfo',return_value=[(2,1,6,'',('127.0.0.1',80))]), patch.object(web.socket,'create_connection') as connect:
            with self.assertRaises(ValueError):
                web.fetch('http://local.example/')
            connect.assert_not_called()


class GitDelivery(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        base = Path(self.tmp.name).resolve()
        self.root, self.remote, self.candidate = (base/x for x in ('project','remote','candidate'))
        for d in [self.root,self.remote,self.candidate]:
            d.mkdir()
        self.url = 'https://github.com/example/fixture.git'
        self.call(self.remote,'init','--bare','-qb','main')
        self.call(self.root,'init','-qb','main')
        (self.root/'report.txt').write_text('original\n')
        self.call(self.root,'add','report.txt')
        self.call(self.root,'-c','user.name=Fixture','-c','user.email=test@example.invalid','commit','-qm','init')
        self.call(self.root,'push',str(self.remote),'main')
        self.call(self.root,'remote','add','origin',self.url)
        self.fd = os.open(self.root,os.O_DIRECTORY)
        self.addCleanup(os.close,self.fd)
        self.dev = os.fstat(self.fd).st_dev
        self.cfg = {'message':'Update','date':'2026-01-01T00:00:00Z','files':[{'path':'report.txt','before':delivery.digest(b'original\n'),'after':delivery.digest(b'new\n')}]}
        (self.root/'report.txt').write_text('new\n')
        (self.root/'user.txt').write_text('staged')
        self.call(self.root,'add','user.txt')
        (self.root/'user.txt').write_text('unstaged')

    @staticmethod
    def call(root,*args):
        return subprocess.run(['/usr/bin/git','-C',str(root),*args],stdout=subprocess.PIPE,stderr=subprocess.PIPE,check=True).stdout

    def adapter(self,cwd,*args,**kwargs):
        if self.url in args:
            args = tuple(str(self.remote) if x==self.url else x for x in args)
            data = self.call(cwd,*args)
            return data
        return self.real_git(cwd,*args,**kwargs)

    def run_preview(self):
        self.real_git = delivery.git
        with patch.object(delivery,'git',side_effect=self.adapter):
            return delivery.prepare(self.root,self.fd,self.dev,self.candidate,self.cfg)

    def test_commit_contains_only_the_member_file_and_leaves_user_index_intact(self):
        index=(self.root/'.git/index').read_bytes()
        plan=self.run_preview()
        self.assertEqual(plan['remote'],self.url)
        self.assertEqual(plan['files'],['report.txt'])
        self.assertIn('+new',plan['diff'])
        self.assertNotIn('staged',plan['diff'])
        self.assertEqual(self.call(self.candidate,'ls-tree','--name-only',plan['commit']).decode().strip(),'report.txt')
        self.assertEqual(self.call(self.candidate,'show',plan['commit']+':report.txt'),b'new\n')
        self.assertEqual(self.call(self.remote,'rev-parse','main').decode().strip(),plan['parent'])
        self.assertEqual((self.root/'.git/index').read_bytes(),index)
        self.assertEqual((self.root/'user.txt').read_text(),'unstaged')

    def test_rejects_overlapping_staged_user_edits(self):
        self.call(self.root,'add','report.txt')
        with self.assertRaisesRegex(delivery.Refused,'暂存'):
            self.run_preview()

    def test_rejects_earlier_unstaged_or_later_content_edits(self):
        self.cfg['files'][0]['before']=delivery.digest(b'user draft')
        with self.assertRaisesRegex(delivery.Refused,'开始前'):
            self.run_preview()
        self.cfg['files'][0]['after']=delivery.digest(b'changed again')
        with self.assertRaisesRegex(delivery.Refused,'已改变'):
            self.run_preview()

    def complete(self, plan):
        with patch.object(delivery, 'git', side_effect=self.adapter):
            return delivery.complete('push', self.root, self.fd, self.dev, self.candidate, {**self.cfg, 'plan': plan})

    def test_delivery_and_retry_leave_the_user_index_unchanged(self):
        index = (self.root/'.git/index').read_bytes()
        plan = self.run_preview()
        for _ in range(2):
            self.assertEqual(self.complete(plan)['tip'], plan['commit'])
        self.assertEqual(self.call(self.remote, 'rev-parse', 'main').decode().strip(), plan['commit'])
        self.assertEqual((self.root/'.git/index').read_bytes(), index)

    def test_changes_after_preview_require_review_again(self):
        plan = self.run_preview()
        (self.root/'report.txt').write_text('changed since preview\n')
        with self.assertRaisesRegex(delivery.Refused, '已改变'):
            self.complete(plan)
        self.assertEqual(self.call(self.remote, 'rev-parse', 'main').decode().strip(), plan['parent'])

    def test_refuses_to_replace_an_unrelated_remote_commit(self):
        plan = self.run_preview()
        self.call(self.root, '-c', 'user.name=Fixture', '-c', 'user.email=test@example.invalid',
                  'commit', '-qm', 'Independent change')
        self.call(self.root, 'push', str(self.remote), 'main')
        tip = self.call(self.remote, 'rev-parse', 'main')
        self.call(self.root, 'update-ref', 'refs/heads/main', plan['local'])
        with self.assertRaisesRegex(delivery.Refused, '远端分支已变化'):
            self.complete(plan)
        self.assertEqual(self.call(self.remote, 'rev-parse', 'main'), tip)

    def test_pull_work_branch_and_revision_preserve_base_and_user_changes(self):
        index = (self.root/'.git/index').read_bytes()
        base = self.call(self.remote, 'rev-parse', 'main').decode().strip()
        branch = 'codex/collab-fixture'
        self.cfg['pull'] = {'branch':branch, 'base':'main', 'repair': True}
        first = self.run_preview()
        self.assertEqual(first['pull']['expectedHead'], None)
        self.assertEqual(first['branch'], branch)
        self.assertEqual(self.complete(first)['tip'], first['commit'])
        self.assertEqual(self.complete(first)['tip'], first['commit'])
        self.assertEqual(self.call(self.remote, 'rev-parse', 'main').decode().strip(), base)
        self.candidate = self.candidate.parent/'second'
        self.candidate.mkdir()
        (self.root/'report.txt').write_text('fixed\n')
        self.cfg['files']=[{'path':'report.txt','before':delivery.digest(b'new\n'),'after':delivery.digest(b'fixed\n')}]
        self.cfg['pull'].update(expectedHead=first['commit'], number=17)
        second=self.run_preview()
        self.assertEqual(second['parent'],first['commit'])
        self.assertEqual(second['pull']['number'],17)
        self.assertEqual(self.complete(second)['tip'],second['commit'])
        self.assertEqual(self.call(self.remote,'show',branch+':report.txt'),b'fixed\n')
        self.assertEqual(self.call(self.remote,'rev-parse','main').decode().strip(),base)
        self.assertEqual((self.root/'.git/index').read_bytes(),index)
        self.assertEqual((self.root/'user.txt').read_text(),'unstaged')
