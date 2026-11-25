package jsrt

import "errors"

// errWorkerClosed 表示 worker 已经停止，无法再执行任务。
var errWorkerClosed = errors.New("JS 运行时已停止")
