# Test fixtures

Generated genomics files used by the integration and contract tests. They live
in `generated/`, which is gitignored, so regenerate them locally:

```sh
python3 -m venv .venv
.venv/bin/pip install pysam pyBigWig numpy
.venv/bin/python scripts/make-fixtures.py            # ~6 s, ~85 MB
.venv/bin/python scripts/make-fixtures.py --skip-large   # everything except large.bam
.venv/bin/python scripts/make-fixtures.py --perf-bam-gb 2   # also write a ~2 GB perf.bam
```

The generator is deterministic (fixed seeds) and overwrites existing output.
Indexing uses pysam's bundled htslib, so samtools/tabix/bgzip are not needed.
`generated/MANIFEST.json` lists every file with its size and key facts
(SNP alleles, read counts, the gene nearest the SNP).

## Files

| File | Purpose |
| --- | --- |
| `ref.fa`, `ref.fa.fai` | Reference with `chrS` (5 Mb) and `chrT` (50 kb); random ACGT, 60 bp lines |
| `small.bam`, `small.bam.bai` | 2,000 single-end 100 bp reads on `chrT`, MAPQ 60, `100M`, Q30, ~0.5% mismatches; quick alignment-track tests |
| `small.cram`, `small.cram.crai` | The same 2,000 records as `small.bam`, written as CRAM 3 against `ref.fa` (~4 KB); readers must be given `ref.fa` as the reference. Its `@SQ` lines carry `M5:` and the absolute `UR:` path of `ref.fa`, so the bytes differ between output directories (but not between runs into the same one) |
| `large.bam`, `large.bam.bai` | ~600k reads over `chrS` (~12x, ~55 MB) for large-file handling; planted heterozygous SNP at `chrS:1,000,000` (depth ~47, ~50% alt; alleles in the manifest) |
| `coverage.bw` | bigWig with 1 kb bins on both contigs (sine + noise, non-negative) |
| `genes.bed` | 51 sorted BED6 features `gene1`..`gene51`; one spans `chrS:999500-1000500`, next to the SNP |
| `genes.gff3` | Same features as GFF3 `gene` records with `ID=`/`Name=` |
| `variants.vcf.gz`, `.tbi` | VCF 4.2, 30 sorted SNPs on `chrS`, including `chrS:1000000` matching the planted SNP (`ID=planted_snp`) |
| `unindexed_big.bed` | Plain BED6 just over 20 MiB (580k sorted lines) with no index; exercises the "file too large without an index" path |
| `noindex.bam` | Byte copy of `small.bam` with no `.bai`; exercises the missing-index path |
| `perf.bam`, `perf.bam.bai`, `perf_ref.fa`, `perf_ref.fa.fai` | Optional (`--perf-bam-gb N`, default 0 = skip). About N GB of coordinate-sorted 100 bp reads at ~30x over their own multi-chromosome reference (`perf_ref.fa`, 15 Mb chromosomes), random Q2-Q41 qualities, for large-file performance testing |
| `MANIFEST.json` | Sizes and facts for all of the above |

## perf.bam and perf_ref.fa

`perf.bam` is not produced by default because it is large and slow to write
(roughly 90 s and 10.8 M reads per GB). Request it with `--perf-bam-gb N`
(fractional values work, e.g. `0.25`; the cap is 12 GB). Unlike the other
fixtures it has its own reference, `perf_ref.fa`, sized so that the depth is a
realistic ~30x (a 5 GB BAM over the 5 Mb `chrS` would be ~1000x, which makes
every BAI bin hold tens of MB and says nothing about real data):

```
target_bytes   = N * 1e9
bytes_per_read = size(large.bam) / reads(large.bam)   # ~92.3 B/read; constant fallback with --skip-large
n_reads        = target_bytes / bytes_per_read
genome_len     = n_reads * 100 / 30                   # about N * 36 Mb
chromosomes    = ceil(genome_len / 15,000,000) x 15 Mb  (perfChr1, perfChr2, …)
```

Reads are generated per chromosome and per 100 kb window (sorted within the
window; every read of window k starts before any read of window k+1), so the
file is coordinate-sorted without ever holding all reads in memory, and each
chromosome's sequence is written to `perf_ref.fa` as it is generated. Progress
is printed about every 5%. When `--perf-bam-gb` is 0 existing perf files are
left in place (and still listed in the manifest); only the other fixtures are
regenerated. All generation uses its own seeded RNG, so the other outputs are
byte-identical with or without the flag.

Run the perf job with `npm run test:perf` (sets `IGV_PERF=1`); it writes
`PERF.md` next to the fixtures.

The `workspace/` directory is the VS Code test workspace opened by the
integration tests.
