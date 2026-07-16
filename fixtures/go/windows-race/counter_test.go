package windowsrace

import (
	"sync"
	"testing"
)

func TestCounterIsSafeUnderConcurrentUpdates(t *testing.T) {
	t.Parallel()
	const (
		writers    = 8
		increments = 100
	)
	var counter Counter
	var workers sync.WaitGroup
	workers.Add(writers)
	for range writers {
		go func() {
			defer workers.Done()
			for range increments {
				counter.Increment()
			}
		}()
	}
	workers.Wait()
	if got, want := counter.Value(), int64(writers*increments); got != want {
		t.Fatalf("counter = %d, want %d", got, want)
	}
}
