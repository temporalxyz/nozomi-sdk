//go:build race

package nozomi

// Under the race detector sync.Pool.Put drops a quarter of its items, so a
// send allocates a fresh job now and then; measure allocations without -race.
func init() { raceEnabled = true }
