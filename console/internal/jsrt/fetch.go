package jsrt

import (
	"io"
	"net/http"
	"strings"
	"time"
)

// fetchSync 是 hostjs 用的同步 HTTP 客户端。
// 插件里的 fetch 是异步的，但 QuickJS 的 Go 绑定不支持在回调里 await，
// 所以这里同步阻塞，由 JS 侧的垫片包成 async 函数。
func fetchSync(method, url string, headers map[string]string, body string) (int, string) {
	method = strings.ToUpper(strings.TrimSpace(method))
	if method == "" {
		method = http.MethodGet
	}
	var reader io.Reader
	if body != "" {
		reader = strings.NewReader(body)
	}
	req, err := http.NewRequest(method, url, reader)
	if err != nil {
		return 0, ""
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	// 插件里的 UA 是它自己设的；这里只在缺失时补一个，避免被服务端拒
	if req.Header.Get("User-Agent") == "" {
		req.Header.Set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36")
	}

	client := &http.Client{Timeout: 30 * time.Second}
	res, err := client.Do(req)
	if err != nil {
		return 0, ""
	}
	defer res.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(res.Body, 16<<20))
	if err != nil {
		return res.StatusCode, ""
	}
	return res.StatusCode, string(raw)
}
