package jsrt

import (
	"io"
	"net/http"
	"strings"
	"time"
)

// logFetch 让上层把 fetch 的失败原因写进日志，否则插件只会看到「HTTP 0」。
var logFetch = func(string) {}

// SetFetchLogger 由 Runtime 在创建时接上。
func SetFetchLogger(fn func(string)) {
	if fn != nil {
		logFetch = fn
	}
}

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
		logFetch("fetch 构造请求失败 " + url + ": " + err.Error())
		return 0, "fetch error: " + err.Error()
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	if req.Header.Get("User-Agent") == "" {
		req.Header.Set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36")
	}

	// 超时不能太长：fetch 是在 worker 线程上同步阻塞的，
	// 一次慢请求会把整个 JS 运行时卡住，其他请求全部排队等。
	client := &http.Client{Timeout: 8 * time.Second}
	res, err := client.Do(req)
	if err != nil {
		logFetch("fetch " + method + " " + url + " 失败: " + err.Error())
		return 0, "fetch error: " + err.Error()
	}
	defer res.Body.Close()

	raw, err := io.ReadAll(io.LimitReader(res.Body, 16<<20))
	if err != nil {
		logFetch("fetch 读响应失败 " + url + ": " + err.Error())
		return res.StatusCode, ""
	}
	return res.StatusCode, string(raw)
}
