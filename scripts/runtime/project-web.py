"""Read public web sources through a credential-free, address-pinned HTTP client."""
import errno
import http.client
import ipaddress
import json
import re
import socket
import ssl
import sys
from html.parser import HTMLParser
from urllib.parse import urlencode, urljoin, urlsplit, urlunsplit
from xml.etree import ElementTree


class Unavailable(ValueError):
    pass


def public_url(raw):
    if len(raw) > 2048 or re.search(r'[\x00-\x20\x7f\\]', raw):
        raise Unavailable('网址无效。')
    url = urlsplit(raw)
    if (url.scheme not in ('https', 'http') or not url.hostname or url.username is not None
            or url.password is not None or url.port not in (None, 443 if url.scheme == 'https' else 80)):
        raise Unavailable('仅支持公开的 HTTP 或 HTTPS 网页。')
    host = url.hostname.rstrip('.').lower()
    if '.' not in host or host.endswith(('.local', '.localhost', '.internal', '.home.arpa')) or not host.isascii():
        raise Unavailable('请选择公开网站。')
    return urlunsplit((url.scheme, url.netloc, url.path or '/', url.query, ''))


def fetch(raw):
    try:
        return fetch_once(raw, 0)
    except (TimeoutError, socket.timeout, ConnectionError, ssl.SSLEOFError, http.client.IncompleteRead):
        pass
    except OSError as error:
        if error.errno not in (socket.EAI_AGAIN, errno.EHOSTUNREACH, errno.ENETUNREACH):
            raise
    # Restart the read with freshly validated DNS and use another address if available.
    return fetch_once(raw, 1)


def fetch_once(raw, attempt):
    url = public_url(raw)
    for _ in range(5):
        u = urlsplit(url)
        port = u.port or (443 if u.scheme == 'https' else 80)
        addresses = socket.getaddrinfo(u.hostname, port, type=socket.SOCK_STREAM)
        for _, _, _, _, endpoint in addresses:
            addr = ipaddress.ip_address(endpoint[0])
            if not addr.is_global or addr.is_multicast or getattr(addr, 'ipv4_mapped', None) or getattr(addr, 'sixtofour', None) or getattr(addr, 'teredo', None) or addr in ipaddress.ip_network('64:ff9b::/96'):
                raise Unavailable('该网址未指向公开网站。')
        # Connect to the validated address and verify TLS against the original hostname.
        addresses.sort(key=lambda entry: entry[0] != socket.AF_INET)
        conn = http.client.HTTPConnection(u.hostname, port, timeout=6)
        try:
            endpoint = addresses[min(attempt, len(addresses) - 1)][4]
            conn.sock = socket.create_connection(endpoint[:2], timeout=6)
            if u.scheme == 'https':
                conn.sock = ssl.create_default_context().wrap_socket(conn.sock, server_hostname=u.hostname)
            conn.request('GET', urlunsplit(('', '', u.path, u.query, '')), headers={
                'User-Agent': 'Multi-Agent-Collab/1.0', 'Accept-Encoding': 'identity',
                'Accept': 'text/html, application/rss+xml, application/xml, text/plain, text/markdown'})
            response = conn.getresponse()
            if response.status in (301, 302, 303, 307, 308):
                location = response.getheader('Location')
                if not location:
                    raise Unavailable('网页重定向缺少目标。')
                url = public_url(urljoin(url, location))
                continue
            if response.status != 200:
                raise Unavailable('网页读取失败（HTTP %d）。' % response.status)
            content_type = response.headers.get_content_type()
            if content_type not in ('text/html', 'application/xhtml+xml', 'text/plain', 'text/markdown',
                                    'application/rss+xml', 'application/xml', 'text/xml'):
                raise Unavailable('该页面没有可读取的文本正文。')
            data = response.read(2 * 1024 * 1024 + 1)
            if len(data) > 2 * 1024 * 1024:
                raise Unavailable('网页过大，请选择具体的文档页面。')
            return url, content_type, data.decode(response.headers.get_content_charset() or 'utf-8', 'replace')
        finally:
            conn.close()
    raise Unavailable('网页重定向次数过多。')


class Article(HTMLParser):
    hidden = {'script', 'style', 'noscript', 'template', 'svg', 'head'}
    def __init__(self):
        super().__init__()
        self.parts, self.title = [], []
        self.skipped = []
        self.in_title = False

    def handle_starttag(self, tag, attrs):
        if tag == 'title':
            self.in_title = True
        if tag in self.hidden:
            self.skipped.append(tag)
        if tag in ('p', 'article', 'section', 'li', 'br', 'pre', 'h1', 'h2', 'h3', 'tr'):
            self.parts.append('\n')

    def handle_endtag(self, tag):
        if tag == 'title':
            self.in_title = False
        if self.skipped and self.skipped[-1] == tag:
            self.skipped.pop()

    def handle_data(self, data):
        if self.in_title:
            self.title.append(data)
        if not self.skipped:
            self.parts.append(data)


def run(action, args):
    if action == 'search':
        url, _, body = fetch('https://www.bing.com/search?' + urlencode({'format': 'rss', 'q': args['query']}))
        root = ElementTree.fromstring(body)
        if root.tag != 'rss':
            raise Unavailable('搜索服务暂时不可用。')
        results = []
        for item in root.findall('./channel/item')[:10]:
            try:
                link = public_url(item.findtext('link') or '')
            except ValueError:
                continue
            results.append({'title': (item.findtext('title') or '')[:240], 'url': link,
                            'snippet': (item.findtext('description') or '')[:400]})
        return {'query': args['query'], 'source': url, 'results': results}
    url, kind, body = fetch(args['url'])
    title = ''
    if kind in ('text/html', 'application/xhtml+xml'):
        article = Article()
        article.feed(body)
        title = ' '.join(''.join(article.title).split())[:240]
        body = '\n'.join(' '.join(line.split()) for line in ''.join(article.parts).splitlines() if line.strip())
    if not body.strip():
        raise Unavailable('没有可读取的正文。')
    start = args.get('offset', 0)
    if start >= len(body):
        raise Unavailable('指定位置已超出正文。')
    end = min(len(body), start + 10000)
    return {'url': url, 'title': title, 'offset': start, 'text': body[start:end],
            **({'nextOffset': end} if end < len(body) else {})}


if __name__ == '__main__':
    try:
        print(json.dumps(run(sys.argv[1], json.loads(sys.argv[2]))))
    except Exception as error:
        print(json.dumps({'error': str(error) if isinstance(error, Unavailable) else '连接或读取公开网页失败。'}))
