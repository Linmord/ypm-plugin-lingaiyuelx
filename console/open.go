package main

import (
	"fmt"
	"os/exec"
	"runtime"
)

// openURL 用系统默认浏览器打开地址。
func openURL(url string) error {
	switch runtime.GOOS {
	case "windows":
		return exec.Command("rundll32", "url.dll,FileProtocolHandler", url).Start()
	case "darwin":
		return exec.Command("open", url).Start()
	default:
		return exec.Command("xdg-open", url).Start()
	}
}

var _ = fmt.Sprintf
