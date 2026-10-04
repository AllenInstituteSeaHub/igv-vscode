#!/usr/bin/env python3
"""Generate deterministic genomics test fixtures for the igv-vscode extension.

Usage (from the repo root):

    python3 -m venv .venv
    .venv/bin/pip install pysam pyBigWig numpy
    .venv/bin/python scripts/make-fixtures.py [--out DIR] [--skip-large] [--perf-bam-gb N]

Everything is seeded, so re-running produces byte-identical text outputs and
equivalent binary outputs. Existing files in the output directory are
overwritten. Indexing is done with pysam's bundled htslib functions, so no
samtools/tabix/bgzip binaries are required.

Outputs (default DIR = test/fixtures/generated):
  ref.fa, ref.fa.fai          two-contig reference (chrS 5 Mb, chrT 50 kb)
  small.bam, small.bam.bai    ~2,000 reads on chrT
  small.cram, small.cram.crai the same 2,000 reads as CRAM against ref.fa
  large.bam, large.bam.bai    ~600,000 reads on chrS (~60 MB) with a planted
                              heterozygous SNP at chrS:1,000,000
  coverage.bw                 bigWig, 1 kb bins over both contigs
  genes.bed, genes.gff3       ~50 gene features (one near the SNP)
  variants.vcf.gz(.tbi)       ~30 SNPs on chrS including the planted one
  unindexed_big.bed           BED6 text file just over 20 MiB, no index
  noindex.bam                 copy of small.bam with no .bai
  perf.bam, perf.bam.bai,     only with --perf-bam-gb N (N > 0): ~N GB of
  perf_ref.fa, perf_ref.fa.fai  coordinate-sorted ~30x reads over their own
                              multi-chromosome reference, for performance
                              testing; streamed, never held in memory
  MANIFEST.json               file sizes and key facts
"""

from __future__ import annotations

import argparse
import json
import random
import shutil
import sys
import time
from array import array
from pathlib import Path

import numpy as np
import pysam
import pyBigWig

SEED = 42

# Reference layout -----------------------------------------------------------
CHROMS = [("chrS", 5_000_000), ("chrT", 50_000)]
FASTA_LINE = 60

# Reads --------------------------------------------------------------------
READ_LEN = 100
MISMATCH_RATE = 0.005
SMALL_READS = 2_000
LARGE_DEPTH = 12  # background depth over chrS
# 12x over 5 Mb with 100 bp reads = 600,000 reads
LARGE_READS = LARGE_DEPTH * CHROMS[0][1] // READ_LEN
LARGE_TARGET_BYTES = 60 * 1024 * 1024

# Planted SNP (1-based position on chrS)
SNP_CHROM = "chrS"
SNP_POS_1BASED = 1_000_000
SNP_POS = SNP_POS_1BASED - 1  # 0-based
SNP_MIN_DEPTH = 25
SNP_EXTRA_READS = 22  # extra reads forced to cover the SNP
SNP_ALT_FRACTION = 0.5
# large.bam uses random per-base qualities in [LARGE_QUAL_MIN, LARGE_QUAL_MAX];
# constant qualities compress to almost nothing and the file would be ~11 MB.
LARGE_QUAL_MIN, LARGE_QUAL_MAX = 2, 41

# perf.bam (optional, --perf-bam-gb N) -----------------------------------------
# A realistic large BAM: fixed ~30x depth over its OWN reference (perf_ref.fa),
# whose size is derived from the requested BAM size, so BAI bins and 2 kb views
# hold as many reads as in a real WGS BAM:
#
#     target_bytes   = N * 1e9                       (decimal GB)
#     bytes_per_read = size(large.bam) / reads(large.bam)
#                      (~92.3 B/read with random Q2-Q41 qualities; this
#                      constant is the fallback when large.bam was skipped)
#     n_reads        = target_bytes / bytes_per_read
#     genome_len     = n_reads * READ_LEN / PERF_DEPTH   ->  about N * 36 Mb
#     chromosomes    = ceil(genome_len / PERF_CHROM_LEN) of PERF_CHROM_LEN bp
#
# so 5 GB ~ 54 M reads ~ 180 Mb of reference in 12 chromosomes of 15 Mb.
PERF_DEPTH = 30
PERF_CHROM_LEN = 15_000_000
PERF_MAX_GB = 12.0  # refuse larger requests to avoid filling a disk by accident
PERF_WINDOW = 100_000  # reads are generated per window; all reads of window k
#                        start before any read of window k+1, so the output is
#                        coordinate-sorted without a global sort in memory
PERF_FALLBACK_BYTES_PER_READ = 92.3
PERF_RNG_SEED = SEED + 10
PERF_CHUNK = 10_000  # reads per inner batch (quality block / write loop)

# Annotation ---------------------------------------------------------------
N_GENES_S = 40
N_GENES_T = 10
SNP_GENE_START = 999_500  # BED (0-based) start of the feature near the SNP
SNP_GENE_END = 1_000_500

N_VARIANTS = 30
BIGWIG_BIN = 1_000
UNINDEXED_BED_TARGET_BYTES = int(21.5 * 1_000_000)  # just over 20 MiB

BASES = b"ACGT"
QUAL30 = pysam.qualitystring_to_array("?" * READ_LEN)  # Q30 = '?'


def log(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)


def remove(path: Path) -> None:
    try:
        path.unlink()
    except FileNotFoundError:
        pass


# ---------------------------------------------------------------------------
# Reference
# ---------------------------------------------------------------------------
def make_reference(out: Path, nprng: np.random.Generator) -> dict[str, bytes]:
    ref: dict[str, bytes] = {}
    fa = out / "ref.fa"
    remove(fa)
    remove(out / "ref.fa.fai")
    lookup = np.frombuffer(BASES, dtype=np.uint8)
    with open(fa, "wb") as fh:
        for name, length in CHROMS:
            seq = lookup[nprng.integers(0, 4, size=length, dtype=np.uint8)].tobytes()
            ref[name] = seq
            fh.write(f">{name}\n".encode())
            for i in range(0, length, FASTA_LINE):
                fh.write(seq[i : i + FASTA_LINE])
                fh.write(b"\n")
    pysam.faidx(str(fa))
    return ref


# ---------------------------------------------------------------------------
# BAM helpers
# ---------------------------------------------------------------------------
def bam_header() -> dict:
    return {
        "HD": {"VN": "1.6", "SO": "coordinate"},
        "SQ": [{"SN": name, "LN": length} for name, length in CHROMS],
        "RG": [{"ID": "rg1", "SM": "sample1", "LB": "lib1", "PL": "ILLUMINA"}],
        "PG": [{"ID": "make-fixtures", "PN": "make-fixtures.py", "VN": "1.0"}],
    }


def mutate(seq: bytearray, positions, rng: random.Random) -> None:
    """Replace each position with a different random base."""
    for p in positions:
        orig = seq[p]
        choices = [b for b in BASES if b != orig]
        seq[p] = rng.choice(choices)


def write_reads(
    bam_path: Path,
    ref_seq: bytes,
    tid: int,
    starts: np.ndarray,
    name_prefix: str,
    rng: random.Random,
    nprng: np.random.Generator,
    snp: tuple[int, int] | None = None,  # (0-based pos, alt base ord)
    snp_alt_mask: np.ndarray | None = None,
    random_quals: bool = False,
) -> int:
    """Write coordinate-sorted single-end reads. `starts` must be sorted."""
    n = len(starts)
    n_mismatch = nprng.binomial(READ_LEN, MISMATCH_RATE, size=n)
    snp_pos = snp[0] if snp else -1
    snp_alt = snp[1] if snp else 0
    QUAL_CHUNK = 10_000
    qual_block = None
    with pysam.AlignmentFile(str(bam_path), "wb", header=bam_header()) as bam:
        for i in range(n):
            start = int(starts[i])
            if random_quals:
                j = i % QUAL_CHUNK
                if j == 0:
                    qual_block = nprng.integers(
                        LARGE_QUAL_MIN, LARGE_QUAL_MAX + 1,
                        size=(min(QUAL_CHUNK, n - i), READ_LEN), dtype=np.uint8,
                    )
                quals = array("B", qual_block[j].tobytes())
            else:
                quals = QUAL30
            seq = bytearray(ref_seq[start : start + READ_LEN])
            k = int(n_mismatch[i])
            if k:
                mutate(seq, rng.sample(range(READ_LEN), k), rng)
            if snp is not None and start <= snp_pos < start + READ_LEN:
                off = snp_pos - start
                seq[off] = snp_alt if snp_alt_mask[i] else ref_seq[snp_pos]
            a = pysam.AlignedSegment()
            a.query_name = f"{name_prefix}{i:07d}"
            a.flag = 0 if (i & 1) == 0 else 16  # alternate strand for variety
            a.reference_id = tid
            a.reference_start = start
            a.mapping_quality = 60
            a.cigartuples = [(0, READ_LEN)]
            a.next_reference_id = -1
            a.next_reference_start = -1
            a.template_length = 0
            a.query_sequence = seq.decode("ascii")
            a.query_qualities = quals
            a.set_tags([("RG", "rg1", "Z"), ("NM", k, "i")])
            bam.write(a)
    pysam.index(str(bam_path))
    return n


def make_small_bam(out: Path, ref: dict[str, bytes], rng: random.Random, nprng) -> dict:
    path = out / "small.bam"
    remove(path)
    remove(out / "small.bam.bai")
    chrom_len = CHROMS[1][1]
    starts = np.sort(nprng.integers(0, chrom_len - READ_LEN + 1, size=SMALL_READS))
    n = write_reads(path, ref["chrT"], 1, starts, "small_", rng, nprng)
    return {"reads": n, "chrom": "chrT", "read_length": READ_LEN, "mapq": 60}


def make_large_bam(out: Path, ref: dict[str, bytes], alt: str, rng: random.Random, nprng) -> dict:
    path = out / "large.bam"
    remove(path)
    remove(out / "large.bam.bai")
    chrom_len = CHROMS[0][1]
    ref_seq = ref["chrS"]

    ref_base = ref_seq[SNP_POS]
    alt_base = ord(alt)
    assert alt_base != ref_base

    background = nprng.integers(0, chrom_len - READ_LEN + 1, size=LARGE_READS)
    # Extra reads whose span includes the SNP position.
    extra = nprng.integers(SNP_POS - READ_LEN + 1, SNP_POS + 1, size=SNP_EXTRA_READS)
    starts = np.sort(np.concatenate([background, extra]))

    covering = np.flatnonzero((starts <= SNP_POS) & (SNP_POS < starts + READ_LEN))
    # Exactly ~50% alt: shuffle covering reads and flag the first half.
    cov_list = covering.tolist()
    rng.shuffle(cov_list)
    n_alt = int(round(len(cov_list) * SNP_ALT_FRACTION))
    alt_mask = np.zeros(len(starts), dtype=bool)
    alt_mask[cov_list[:n_alt]] = True

    log(f"  large.bam: {len(starts):,} reads, {len(cov_list)} cover chrS:{SNP_POS_1BASED}, "
        f"{n_alt} carry alt ({chr(ref_base)}>{chr(alt_base)})")
    n = write_reads(path, ref_seq, 0, starts, "large_", rng, nprng,
                    snp=(SNP_POS, alt_base), snp_alt_mask=alt_mask, random_quals=True)
    return {
        "reads": n,
        "background_reads": int(LARGE_READS),
        "background_depth": LARGE_DEPTH,
        "chrom": "chrS",
        "read_length": READ_LEN,
        "qualities": f"random uniform Q{LARGE_QUAL_MIN}-Q{LARGE_QUAL_MAX}",
        "snp": {
            "chrom": SNP_CHROM,
            "pos": SNP_POS_1BASED,
            "ref": chr(ref_base),
            "alt": chr(alt_base),
            "planned_depth": len(cov_list),
            "planned_alt_reads": n_alt,
        },
        "target_bytes": LARGE_TARGET_BYTES,
    }


# ---------------------------------------------------------------------------
# CRAM copy of small.bam
# ---------------------------------------------------------------------------
def make_small_cram(out: Path) -> dict:
    """Re-read small.bam and write the same records as CRAM against ref.fa."""
    bam_path = out / "small.bam"
    cram_path = out / "small.cram"
    ref_fa = out / "ref.fa"
    remove(cram_path)
    remove(out / "small.cram.crai")
    n = 0
    with pysam.AlignmentFile(str(bam_path), "rb") as bam:
        with pysam.AlignmentFile(
            str(cram_path), "wc", header=bam.header, reference_filename=str(ref_fa)
        ) as cram:
            for rec in bam:
                cram.write(rec)
                n += 1
    pysam.index(str(cram_path))
    return {"reads": n, "source": "small.bam", "reference": "ref.fa",
            "bytes": cram_path.stat().st_size}


# ---------------------------------------------------------------------------
# perf.bam (optional, streamed)
# ---------------------------------------------------------------------------
def perf_plan_for_gb(gb: float, bytes_per_read: float) -> tuple[int, int, list[tuple[str, int]]]:
    """Return (n_reads, genome_len, chromosomes) for a ~gb GB BAM at PERF_DEPTH; see the PERF_* comment block."""
    if gb > PERF_MAX_GB:
        raise SystemExit(f"--perf-bam-gb {gb} exceeds the safety cap of {PERF_MAX_GB} GB")
    target_bytes = gb * 1e9
    n_reads = int(target_bytes / bytes_per_read)
    genome_len = max(PERF_CHROM_LEN, int(n_reads * READ_LEN / PERF_DEPTH))
    n_chrom = -(-genome_len // PERF_CHROM_LEN)
    chroms = [(f"perfChr{i + 1}", PERF_CHROM_LEN) for i in range(n_chrom)]
    return n_reads, n_chrom * PERF_CHROM_LEN, chroms


def make_perf_bam(out: Path, gb: float, bytes_per_read: float) -> dict:
    path = out / "perf.bam"
    fa = out / "perf_ref.fa"
    for f in (path, out / "perf.bam.bai", fa, out / "perf_ref.fa.fai"):
        remove(f)
    rng = random.Random(PERF_RNG_SEED)
    nprng = np.random.default_rng(PERF_RNG_SEED)
    lookup = np.frombuffer(BASES, dtype=np.uint8)

    n_reads, genome_len, chroms = perf_plan_for_gb(gb, bytes_per_read)
    reads_per_chrom = n_reads // len(chroms)
    header = {
        "HD": {"VN": "1.6", "SO": "coordinate"},
        "SQ": [{"SN": name, "LN": length} for name, length in chroms],
        "RG": [{"ID": "rg1", "SM": "perf", "LB": "lib1", "PL": "ILLUMINA"}],
        "PG": [{"ID": "make-fixtures", "PN": "make-fixtures.py", "VN": "1.0"}],
    }
    log(f"  perf.bam: target {gb:g} GB at {bytes_per_read:.1f} B/read -> {n_reads:,} reads, "
        f"~{PERF_DEPTH}x over {len(chroms)} chromosomes x {PERF_CHROM_LEN:,} bp ({genome_len / 1e6:.0f} Mb, perf_ref.fa)")

    t0 = time.time()
    written = 0
    next_report = 0.05
    with open(fa, "wb") as fah, pysam.AlignmentFile(str(path), "wb", header=header) as bam:
        for ci, (cname, clen) in enumerate(chroms):
            ref_seq = lookup[nprng.integers(0, 4, size=clen, dtype=np.uint8)].tobytes()
            fah.write(f">{cname}\n".encode())
            for i in range(0, clen, FASTA_LINE):
                fah.write(ref_seq[i : i + FASTA_LINE])
                fah.write(b"\n")
            max_start = clen - READ_LEN + 1
            n_windows = -(-max_start // PERF_WINDOW)
            n_c = reads_per_chrom if ci < len(chroms) - 1 else n_reads - reads_per_chrom * (len(chroms) - 1)
            base, extra = divmod(n_c, n_windows)
            for w in range(n_windows):
                lo = w * PERF_WINDOW
                hi = min(lo + PERF_WINDOW, max_start)
                n_w = base + (1 if w < extra else 0)
                if n_w == 0:
                    continue
                starts = np.sort(nprng.integers(lo, hi, size=n_w))
                n_mismatch = nprng.binomial(READ_LEN, MISMATCH_RATE, size=n_w)
                for c0 in range(0, n_w, PERF_CHUNK):
                    c1 = min(c0 + PERF_CHUNK, n_w)
                    qual_block = nprng.integers(
                        LARGE_QUAL_MIN, LARGE_QUAL_MAX + 1, size=(c1 - c0, READ_LEN), dtype=np.uint8
                    )
                    for j in range(c0, c1):
                        start = int(starts[j])
                        seq = bytearray(ref_seq[start : start + READ_LEN])
                        k = int(n_mismatch[j])
                        if k:
                            mutate(seq, rng.sample(range(READ_LEN), k), rng)
                        a = pysam.AlignedSegment()
                        a.query_name = f"perf_{written:09d}"
                        a.flag = 0 if (written & 1) == 0 else 16
                        a.reference_id = ci
                        a.reference_start = start
                        a.mapping_quality = 60
                        a.cigartuples = [(0, READ_LEN)]
                        a.next_reference_id = -1
                        a.next_reference_start = -1
                        a.template_length = 0
                        a.query_sequence = seq.decode("ascii")
                        a.query_qualities = array("B", qual_block[j - c0].tobytes())
                        a.set_tags([("RG", "rg1", "Z"), ("NM", k, "i")])
                        bam.write(a)
                        written += 1
                    frac = written / n_reads
                    if frac >= next_report:
                        size_mb = path.stat().st_size / 1e6
                        log(f"  perf.bam: {frac * 100:5.1f}%  {written:>12,} reads  "
                            f"{size_mb:>9,.1f} MB on disk  {time.time() - t0:6.1f}s")
                        while next_report <= frac:
                            next_report += 0.05
    log("  perf.bam: indexing BAM and reference ...")
    pysam.index(str(path))
    pysam.faidx(str(fa))
    actual = path.stat().st_size
    log(f"  perf.bam: done, {written:,} reads, {actual / 1e9:.3f} GB in {time.time() - t0:.1f}s")
    return {
        "reads": written,
        "depth": PERF_DEPTH,
        "reference": "perf_ref.fa",
        "chromosomes": [c for c, _ in chroms],
        "chromosome_length": PERF_CHROM_LEN,
        "read_length": READ_LEN,
        "qualities": f"random uniform Q{LARGE_QUAL_MIN}-Q{LARGE_QUAL_MAX}",
        "window_bp": PERF_WINDOW,
        "requested_gb": gb,
        "bytes_per_read_assumed": round(bytes_per_read, 2),
        "target_bytes": int(gb * 1e9),
        "actual_bytes": actual,
        "actual_bytes_per_read": round(actual / written, 2) if written else None,
        "formula": f"genome_len = (N*1e9 / bytes_per_read) * READ_LEN / {PERF_DEPTH}, split into {PERF_CHROM_LEN:,} bp chromosomes",
    }


# ---------------------------------------------------------------------------
# bigWig
# ---------------------------------------------------------------------------
def make_bigwig(out: Path, nprng: np.random.Generator) -> dict:
    path = out / "coverage.bw"
    remove(path)
    bw = pyBigWig.open(str(path), "w")
    bw.addHeader(CHROMS)
    total_bins = 0
    for name, length in CHROMS:
        nbins = length // BIGWIG_BIN
        x = np.arange(nbins, dtype=np.float64)
        period = max(nbins / 10.0, 5.0)
        values = 20.0 + 15.0 * np.sin(2 * np.pi * x / period) + nprng.normal(0, 2.0, size=nbins)
        values = np.clip(values, 0.0, None)
        bw.addEntries(name, 0, values=values.tolist(), span=BIGWIG_BIN, step=BIGWIG_BIN)
        total_bins += nbins
    bw.close()
    return {"bin_size": BIGWIG_BIN, "bins": total_bins}


# ---------------------------------------------------------------------------
# Genes (BED + GFF3)
# ---------------------------------------------------------------------------
def make_genes(out: Path, rng: random.Random) -> dict:
    feats: list[tuple[str, int, int, str]] = []
    for chrom, length, n in (("chrS", CHROMS[0][1], N_GENES_S), ("chrT", CHROMS[1][1], N_GENES_T)):
        max_len = min(20_000, length // 5)
        for _ in range(n):
            flen = rng.randint(2_000, max_len)
            start = rng.randint(0, length - flen)
            feats.append((chrom, start, start + flen, rng.choice("+-")))
    feats.append(("chrS", SNP_GENE_START, SNP_GENE_END, "+"))
    feats.sort(key=lambda f: (f[0], f[1], f[2]))

    bed = out / "genes.bed"
    gff = out / "genes.gff3"
    snp_gene = None
    with open(bed, "w") as fb, open(gff, "w") as fg:
        fg.write("##gff-version 3\n")
        for chrom, length in CHROMS:
            fg.write(f"##sequence-region {chrom} 1 {length}\n")
        for i, (chrom, start, end, strand) in enumerate(feats, start=1):
            name = f"gene{i}"
            score = rng.randint(0, 1000)
            fb.write(f"{chrom}\t{start}\t{end}\t{name}\t{score}\t{strand}\n")
            fg.write(f"{chrom}\tmake-fixtures\tgene\t{start + 1}\t{end}\t{score}\t{strand}\t.\t"
                     f"ID={name};Name={name}\n")
            if chrom == "chrS" and start == SNP_GENE_START and end == SNP_GENE_END:
                snp_gene = name
    return {"features": len(feats), "snp_gene": snp_gene,
            "snp_gene_bed": f"chrS\t{SNP_GENE_START}\t{SNP_GENE_END}"}


# ---------------------------------------------------------------------------
# VCF
# ---------------------------------------------------------------------------
def make_vcf(out: Path, ref: dict[str, bytes], snp_ref: str, snp_alt: str, rng: random.Random) -> dict:
    plain = out / "variants.vcf"
    gz = out / "variants.vcf.gz"
    remove(plain)
    remove(gz)
    remove(out / "variants.vcf.gz.tbi")

    chrom_len = CHROMS[0][1]
    positions = set()
    while len(positions) < N_VARIANTS - 1:
        p = rng.randint(1, chrom_len)
        if p != SNP_POS_1BASED:
            positions.add(p)
    positions.add(SNP_POS_1BASED)
    seq = ref["chrS"]

    with open(plain, "w") as fh:
        fh.write("##fileformat=VCFv4.2\n")
        fh.write("##source=make-fixtures.py\n")
        fh.write("##reference=ref.fa\n")
        for name, length in CHROMS:
            fh.write(f"##contig=<ID={name},length={length}>\n")
        fh.write('##INFO=<ID=DP,Number=1,Type=Integer,Description="Total depth">\n')
        fh.write('##INFO=<ID=AF,Number=A,Type=Float,Description="Allele frequency">\n')
        fh.write('##FORMAT=<ID=GT,Number=1,Type=String,Description="Genotype">\n')
        fh.write('##FORMAT=<ID=DP,Number=1,Type=Integer,Description="Read depth">\n')
        fh.write("#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO\tFORMAT\tsample1\n")
        for i, pos in enumerate(sorted(positions), start=1):
            if pos == SNP_POS_1BASED:
                r, a, dp, af, gt, vid = snp_ref, snp_alt, 30, 0.5, "0/1", "planted_snp"
            else:
                r = chr(seq[pos - 1])
                a = rng.choice([c for c in "ACGT" if c != r])
                dp = rng.randint(8, 20)
                gt = rng.choice(["0/1", "1/1"])
                af = 0.5 if gt == "0/1" else 1.0
                vid = f"snp{i}"
            fh.write(f"chrS\t{pos}\t{vid}\t{r}\t{a}\t{rng.randint(30, 99)}\tPASS\t"
                     f"DP={dp};AF={af}\tGT:DP\t{gt}:{dp}\n")

    pysam.tabix_compress(str(plain), str(gz), force=True)
    pysam.tabix_index(str(gz), preset="vcf", force=True)
    remove(plain)
    return {"records": len(positions), "snp_record": f"chrS:{SNP_POS_1BASED} {snp_ref}>{snp_alt}"}


# ---------------------------------------------------------------------------
# Big unindexed BED
# ---------------------------------------------------------------------------
def make_unindexed_bed(out: Path, nprng: np.random.Generator) -> dict:
    path = out / "unindexed_big.bed"
    remove(path)
    chrom_len = CHROMS[0][1]
    # Plenty of sorted starts; we stop once the byte budget is reached.
    n_candidates = 700_000
    starts = np.sort(nprng.integers(0, chrom_len - 1_000, size=n_candidates))
    lengths = nprng.integers(100, 1_000, size=n_candidates)
    scores = nprng.integers(0, 1001, size=n_candidates)
    strands = nprng.integers(0, 2, size=n_candidates)
    written = 0
    lines = 0
    with open(path, "w") as fh:
        # Write in chunks of 10k lines (all ASCII, so len(text) == bytes)
        # until the byte budget is reached.
        for lo in range(0, n_candidates, 10_000):
            hi = min(lo + 10_000, n_candidates)
            text = "".join(
                f"chrS\t{int(starts[i])}\t{int(starts[i]) + int(lengths[i])}\tfeat{i:06d}\t"
                f"{int(scores[i])}\t{'+' if strands[i] else '-'}\n"
                for i in range(lo, hi)
            )
            fh.write(text)
            written += len(text)
            lines += hi - lo
            if written >= UNINDEXED_BED_TARGET_BYTES:
                break
    if written < 20 * 1024 * 1024:
        raise RuntimeError("unindexed_big.bed did not reach 20 MiB; raise n_candidates")
    return {"lines": lines, "min_bytes": 20 * 1024 * 1024}


# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------
def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", default="test/fixtures/generated", help="output directory")
    ap.add_argument("--skip-large", action="store_true", help="skip large.bam (~60 MB)")
    ap.add_argument("--perf-bam-gb", type=float, default=0.0, metavar="N",
                    help="also write perf.bam of about N GB (default 0 = skip; an existing "
                         "perf.bam is left untouched when skipped)")
    args = ap.parse_args()
    if args.perf_bam_gb < 0:
        ap.error("--perf-bam-gb must be >= 0")

    t0 = time.time()
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    rng = random.Random(SEED)
    nprng = np.random.default_rng(SEED)

    facts: dict = {
        "seed": SEED,
        "chroms": {name: length for name, length in CHROMS},
        "snp": {"chrom": SNP_CHROM, "pos": SNP_POS_1BASED},
    }

    log("Writing ref.fa ...")
    ref = make_reference(out, nprng)
    snp_ref = chr(ref["chrS"][SNP_POS])
    facts["snp"]["ref"] = snp_ref

    log("Writing small.bam ...")
    facts["small.bam"] = make_small_bam(out, ref, rng, nprng)

    log("Writing small.cram ...")
    facts["small.cram"] = make_small_cram(out)

    # Decide the alt allele with a dedicated RNG so it is the same whether or
    # not large.bam is generated (the VCF always carries the planted SNP).
    snp_alt = random.Random(SEED + 1).choice([c for c in "ACGT" if c != snp_ref])
    facts["snp"]["alt"] = snp_alt

    if args.skip_large:
        log("Skipping large.bam (--skip-large)")
        remove(out / "large.bam")
        remove(out / "large.bam.bai")
    else:
        log("Writing large.bam ...")
        facts["large.bam"] = make_large_bam(
            out, ref, snp_alt, random.Random(SEED + 2), np.random.default_rng(SEED + 2)
        )

    log("Writing coverage.bw ...")
    facts["coverage.bw"] = make_bigwig(out, np.random.default_rng(SEED + 3))

    log("Writing genes.bed / genes.gff3 ...")
    facts["genes"] = make_genes(out, random.Random(SEED + 4))

    log("Writing variants.vcf.gz ...")
    facts["variants.vcf.gz"] = make_vcf(out, ref, snp_ref, snp_alt, random.Random(SEED + 5))

    log("Writing unindexed_big.bed ...")
    facts["unindexed_big.bed"] = make_unindexed_bed(out, np.random.default_rng(SEED + 6))

    log("Writing noindex.bam ...")
    shutil.copyfile(out / "small.bam", out / "noindex.bam")
    remove(out / "noindex.bam.bai")

    if args.perf_bam_gb > 0:
        log(f"Writing perf.bam (~{args.perf_bam_gb:g} GB) ...")
        if args.skip_large:
            bytes_per_read = PERF_FALLBACK_BYTES_PER_READ
        else:
            bytes_per_read = (out / "large.bam").stat().st_size / facts["large.bam"]["reads"]
        facts["perf.bam"] = make_perf_bam(out, args.perf_bam_gb, bytes_per_read)
    elif (out / "perf.bam").exists():
        log("Keeping existing perf.bam (pass --perf-bam-gb N to regenerate)")

    # Manifest + summary ------------------------------------------------------
    names = [
        "ref.fa", "ref.fa.fai",
        "small.bam", "small.bam.bai",
        "small.cram", "small.cram.crai",
        "large.bam", "large.bam.bai",
        "coverage.bw",
        "genes.bed", "genes.gff3",
        "variants.vcf.gz", "variants.vcf.gz.tbi",
        "unindexed_big.bed",
        "noindex.bam",
        "perf.bam", "perf.bam.bai",
    ]
    files = []
    for name in names:
        p = out / name
        if p.exists():
            files.append({"name": name, "bytes": p.stat().st_size})
    elapsed = time.time() - t0
    if not args.skip_large:
        actual = (out / "large.bam").stat().st_size
        facts["large.bam"]["actual_bytes"] = actual
        facts["large.bam"]["size_ratio_to_target"] = round(actual / LARGE_TARGET_BYTES, 3)
    manifest = {
        "generated_by": "scripts/make-fixtures.py",
        "runtime_seconds": round(elapsed, 1),
        "files": files,
        "facts": facts,
    }
    with open(out / "MANIFEST.json", "w") as fh:
        json.dump(manifest, fh, indent=2)
        fh.write("\n")

    width = max(len(f["name"]) for f in files)
    print(f"\n{'file':<{width}}  {'bytes':>12}")
    print(f"{'-' * width}  {'-' * 12}")
    for f in files:
        print(f"{f['name']:<{width}}  {f['bytes']:>12,}")
    print(f"\nSNP: {SNP_CHROM}:{SNP_POS_1BASED} {snp_ref}>{snp_alt}")
    if not args.skip_large:
        lb = facts["large.bam"]
        print(f"large.bam: {lb['reads']:,} reads, {lb['actual_bytes']:,} bytes "
              f"({lb['size_ratio_to_target']:.2f}x of {LARGE_TARGET_BYTES:,} target)")
    if "perf.bam" in facts:
        pb = facts["perf.bam"]
        print(f"perf.bam: {pb['reads']:,} reads (~{pb['depth']}x), {pb['actual_bytes']:,} bytes "
              f"({pb['actual_bytes'] / 1e9:.3f} GB of {pb['requested_gb']:g} GB requested)")
    print(f"Wrote {out / 'MANIFEST.json'} in {elapsed:.1f}s")
    return 0


if __name__ == "__main__":
    sys.exit(main())
