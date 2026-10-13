import http.server
import time

class HangImageHandler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.send_header("Content-Type", "image/png")
        self.end_headers()
        # 故意进入无限循环，保持 TCP 连接不断开，也不发送完整图片数据
        try:
            while True:
                time.sleep(10)
        except ConnectionError:
            pass

server = http.server.HTTPServer(('127.0.0.1', 8080), HangImageHandler)
print("Starting infinite-hang image server on http://127.0.0.1:8080/img.png")
server.serve_forever()