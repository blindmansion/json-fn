# HOF Argument Order

Higher-order functions take **callback first, data second**. This is consistent across all HOFs: `map(callback, arr)`, `filter(callback, arr)`, `partition(callback, arr)`, `countBy(callback, arr)`, `reduce(callback, init, arr)`, `scan(callback, init, arr)`, etc.

