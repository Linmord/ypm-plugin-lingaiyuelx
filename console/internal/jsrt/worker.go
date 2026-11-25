// worker.go：所有 QuickJS 调用都排到同一个 OS 线程上执行。
//
// 原因：QuickJS 的 JSRuntime 绑定在创建它的线程上。
// HTTP handler 是并发跑的，如果每个 goroutine 各自 LockOSThread，
// 它们会锁到不同线程，Eval 直接返回 nil。
//
// 所以这里起一个常驻 worker：它 LockOSThread 之后只处理队列里的任务，
// 所有调用方把闭包丢进队列并等结果。
package jsrt

import (
	"runtime"
	"sync"
)

// task 是一次要在 worker 线程上执行的工作。
type task struct {
	fn   func() (any, error)
	done chan result
}

type result struct {
	value any
	err   error
}

// worker 串行执行任务，保证所有 QuickJS 调用在同一个线程上。
type worker struct {
	queue  chan *task
	closed chan struct{}
	once   sync.Once
}

func newWorker() *worker {
	w := &worker{
		queue:  make(chan *task, 64),
		closed: make(chan struct{}),
	}
	go w.loop()
	return w
}

func (w *worker) loop() {
	// 锁住这个 goroutine 的 OS 线程，之后所有 QuickJS 调用都在这里发生
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	defer close(w.closed)

	for t := range w.queue {
		v, err := t.fn()
		t.done <- result{value: v, err: err}
	}
}

// do 把任务交给 worker 并等结果。
func (w *worker) do(fn func() (any, error)) (any, error) {
	t := &task{fn: fn, done: make(chan result, 1)}
	defer w.once.Do(func() {})
	select {
	case w.queue <- t:
	case <-w.closed:
		return nil, errWorkerClosed
	}
	r := <-t.done
	return r.value, r.err
}

// stop 关闭 worker。
func (w *worker) stop() {
	close(w.queue)
	<-w.closed
}
