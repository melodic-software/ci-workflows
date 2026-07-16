//go:build windows

package windowsrace

import (
	"os"
	"runtime"
	"testing"
)

func TestNativeWindowsRaceExecution(t *testing.T) {
	t.Parallel()
	if runtime.GOOS != "windows" {
		t.Fatalf("Windows-tagged test ran on %s", runtime.GOOS)
	}
	if !raceDetectorEnabled {
		if os.Getenv("GITHUB_ACTIONS") == "true" {
			t.Fatal("Windows CI test binary was not built with the race detector")
		}
		t.Skip("local test binary was not built with the race detector")
	}
}
