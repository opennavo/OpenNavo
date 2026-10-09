package domain

// PageOffset checks bounds by division before multiplication, avoiding SQL OFFSET or slice overflow for large page numbers.
func PageOffset(current, size int, total int64) (int, bool) {
	if current < 1 || size < 1 || total <= 0 || int64(current-1) > (total-1)/int64(size) || current-1 > int(^uint(0)>>1)/size {
		return 0, false
	}
	return (current - 1) * size, true
}
