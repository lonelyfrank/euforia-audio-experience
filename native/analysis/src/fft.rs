//! Iterative radix-2 FFT with precomputed tables (no allocation per transform),
//! and a stereo helper that transforms two real channels with one complex FFT.

pub struct Fft {
    size: usize,
    /// Twiddles of every stage, contiguous: stage of length `len` uses `len / 2` entries.
    tw_re: Vec<f32>,
    tw_im: Vec<f32>,
    reverse: Vec<u32>,
    re: Vec<f32>,
    im: Vec<f32>,
}

impl Fft {
    pub fn new(size: usize) -> Self {
        assert!(size >= 2 && size.is_power_of_two(), "FFT size must be a power of two");
        let bits = size.trailing_zeros();
        let (mut tw_re, mut tw_im) = (Vec::with_capacity(size), Vec::with_capacity(size));
        let mut len = 2;
        while len <= size {
            for k in 0..len / 2 {
                let angle = -2.0 * std::f64::consts::PI * k as f64 / len as f64;
                tw_re.push(angle.cos() as f32);
                tw_im.push(angle.sin() as f32);
            }
            len <<= 1;
        }
        Self {
            size,
            tw_re,
            tw_im,
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
        for (i, &j) in self.reverse.iter().enumerate() {
            self.re[j as usize] = a[i];
            self.im[j as usize] = b[i];
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
        let mut len = 2;
        let mut offset = 0;
        while len <= n {
            let half = len / 2;
            let (wr, wi) = (&self.tw_re[offset..offset + half], &self.tw_im[offset..offset + half]);
            for (re, im) in self.re.chunks_exact_mut(len).zip(self.im.chunks_exact_mut(len)) {
                let (ra, rb) = re.split_at_mut(half);
                let (ia, ib) = im.split_at_mut(half);
                for ((((ar, ai), br), bi), (wr, wi)) in ra.iter_mut().zip(ia.iter_mut()).zip(rb.iter_mut()).zip(ib.iter_mut()).zip(wr.iter().zip(wi)) {
                    let tr = *br * wr - *bi * wi;
                    let ti = *br * wi + *bi * wr;
                    *br = *ar - tr;
                    *bi = *ai - ti;
                    *ar += tr;
                    *ai += ti;
                }
            }
            offset += half;
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
