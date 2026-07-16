package windowsrace

import "sync/atomic"

// Counter gives the fixture a real concurrent code path for the race-enabled
// test suite to execute.
type Counter struct {
	value atomic.Int64
}

func (c *Counter) Increment() {
	c.value.Add(1)
}

func (c *Counter) Value() int64 {
	return c.value.Load()
}
