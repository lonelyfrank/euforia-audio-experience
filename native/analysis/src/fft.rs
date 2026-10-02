//! Iterative radix-2 FFT with precomputed tables (no allocation per transform),
//! and a stereo helper that transforms two real channels with one complex FFT.

pub struct Fft {
    size: usize,
    cos: Vec<f32>,
    sin: Vec<f32>,
    reverse: Vec<u32>,
    re: Vec<f32>,
    im: Vec<f32>,
}

impl Fft {
    pub fn new(size: usize) -> Self {
        assert!(size >= 2 && size.is_power_of_two(), "FFT size must be a power of two");
        let bits = size.trailing_zeros();
        let half = size / 2;
        let angle = |i: usize| -2.0 * std::f64::consts::PI * i as f64 / size as f64;
        Self {
            size,
            cos: (0..half).map(|i| angle(i).cos() as f32).collect(),
            sin: (0..half).map(|i| angle(i).sin() as f32).collect(),
            reverse: (0..size as u32).map(|i| i.reverse_bits() >> (32 - bits)).collect(),
            re: vec![0.0; size],
            im: vec![0.0; size],
        }
    }

    /// Transforms two real, already windowed signals at once (`a` in the real
    /// part, `b` in the imaginary part) and separates their spectra: writes
    /// the complex bins 0..=size/2 of each into `a_out` / `b_out` as (re, im).
    pub fn stereo(&mut self, a: &[f32], b: &[f32], a_out: &mut [(f32, f32)], b_out: &mut [(f32, f32)]) {
        let n = self.size;
        for i in 0..n {
            let j = self.reverse[i] as usize;
            self.re[j] = a[i];
            self.im[j] = b[i];
        }
        self.butterflies();
        let (re, im) = (&self.re, &self.im);
        for k in 0..=n / 2 {
            let m = (n - k) % n;
            // X[k] = A[k] + i B[k]; conj(X[n-k]) = A[k] - i B[k].
            let (xr, xi, yr, yi) = (re[k], im[k], re[m], -im[m]);
            a_out[k] = (0.5 * (xr + yr), 0.5 * (xi + yi));
            b_out[k] = (0.5 * (xi - yi), -0.5 * (xr - yr));
        }
    }

    fn butterflies(&mut self) {
        let n = self.size;
        let (re, im) = (&mut self.re, &mut self.im);
        let mut len = 2;
        while len <= n {
            let half = len / 2;
            let step = n / len;
            let mut start = 0;
            while start < n {
                for k in 0..half {
                    let (wr, wi) = (self.cos[k * step], self.sin[k * step]);
                    let (a, b) = (start + k, start + k + half);
                    let tr = re[b] * wr - im[b] * wi;
                    let ti = re[b] * wi + im[b] * wr;
                    re[b] = re[a] - tr;
                    im[b] = im[a] - ti;
                    re[a] += tr;
                    im[a] += ti;
                }
                start += len;
            }
            len <<= 1;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn separates_two_channels() {
        let n = 256;
        let mut fft = Fft::new(n);
        let a: Vec<f32> = (0..n).map(|i| (2.0 * std::f32::consts::PI * 8.0 * i as f32 / n as f32).sin()).collect();
        let b: Vec<f32> = (0..n).map(|i| (2.0 * std::f32::consts::PI * 30.0 * i as f32 / n as f32).cos()).collect();
        let mut sa = vec![(0.0, 0.0); n / 2 + 1];
        let mut sb = vec![(0.0, 0.0); n / 2 + 1];
        fft.stereo(&a, &b, &mut sa, &mut sb);
        let mag = |s: &[(f32, f32)], k: usize| (s[k].0.powi(2) + s[k].1.powi(2)).sqrt();
        assert!((mag(&sa, 8) - n as f32 / 2.0).abs() < 1e-2);
        assert!(mag(&sa, 30) < 1e-2);
        assert!((mag(&sb, 30) - n as f32 / 2.0).abs() < 1e-2);
        assert!(mag(&sb, 8) < 1e-2);
    }
}
