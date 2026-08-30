export const passAtK = (n: number, c: number, k: number): number => {
	if (
		!Number.isInteger(n) ||
		!Number.isInteger(c) ||
		!Number.isInteger(k) ||
		n < 0 ||
		c < 0 ||
		c > n ||
		k < 1
	)
		throw new RangeError("invalid pass@k inputs");
	if (k > n) throw new RangeError("k exceeds attempts");
	if (c === 0) return 0;
	if (n - c < k) return 1;
	let product = 1;
	for (let i = 0; i < k; i++) product *= (n - c - i) / (n - i);
	return 1 - product;
};
export const median = (values: number[]) => {
	if (!values.length) return null;
	const sorted = [...values].sort((a, b) => a - b);
	const m = Math.floor(sorted.length / 2);
	return sorted.length % 2
		? (sorted[m] ?? null)
		: ((sorted[m - 1] ?? 0) + (sorted[m] ?? 0)) / 2;
};
export const percentile = (values: number[], p: number) => {
	if (!values.length) return null;
	if (p < 0 || p > 1) throw new RangeError("p must be 0..1");
	const s = [...values].sort((a, b) => a - b),
		i = (s.length - 1) * p,
		l = Math.floor(i),
		h = Math.ceil(i);
	return (s[l] ?? 0) + ((s[h] ?? 0) - (s[l] ?? 0)) * (i - l);
};
