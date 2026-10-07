"""Photo extraction using yt-dlp's TikTok request/challenge handling."""
import json
import re
import sys
from urllib.parse import urlparse
from yt_dlp import YoutubeDL
from yt_dlp.extractor.tiktok import TikTokIE


class PhotoIE(TikTokIE):
    def _get_universal_data(self, webpage, display_id):
        scope = super()._get_universal_data(webpage, display_id)
        # Photo posts can use a different scope from video posts.
        if 'webapp.photo-detail' in scope:
            scope['webapp.video-detail'] = scope['webapp.photo-detail']
        return scope


try:
    url, cookie_path = sys.argv[1:3]
    with YoutubeDL({'verbose': True, 'logtostderr': True, 'socket_timeout': 20,
                   'cookiefile': cookie_path or None}) as ydl:
        parsed = urlparse(url)
        if parsed.hostname in ('vt.tiktok.com', 'vm.tiktok.com') or parsed.path.startswith('/t/'):
            with ydl.urlopen(url) as response:
                url = response.url
        parsed = urlparse(url)
        if parsed.scheme != 'https' or parsed.hostname not in ('www.tiktok.com', 'tiktok.com', 'm.tiktok.com'):
            raise ValueError('Unexpected TikTok redirect host')
        match = re.fullmatch(r'/@[^/]+/photo/(\d+)/?', parsed.path)
        if not match:
            raise ValueError('TikTok link is not a photo post')
        extractor = PhotoIE(ydl)
        extractor.initialize()
        # The /photo page omits itemStruct; /video exposes the same post's images.
        metadata_url = f'https://www.tiktok.com{parsed.path.replace("/photo/", "/video/")}'
        item, status = extractor._extract_web_data_and_status(metadata_url, match[1])
        if status or not item:
            raise ValueError(f'TikTok photo post unavailable (status {status})')
        images = (item.get('imagePost') or {}).get('images') or []
        urls = [image.get('imageURL', {}).get('urlList', []) for image in images]
        urls = [candidates[0] for candidates in urls if candidates]
        if not urls:
            raise ValueError('TikTok photo post contains no accessible images')
        print(json.dumps({'title': item.get('desc') or 'TikTok', 'images': urls}))
except Exception as error:
    print(f'ERROR: TikTok photos: {error}', file=sys.stderr)
    sys.exit(1)
