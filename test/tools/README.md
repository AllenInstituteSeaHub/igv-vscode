# Test tool shims

`bin/` holds small Python stand-ins for the command-line tools the extension
shells out to for indexing and subsampling: `samtools`, `bgzip` and `tabix`.
They are built on [pysam](https://pysam.readthedocs.io/) (which bundles
htslib and the samtools code), so CI runners and developer machines without
bioconda / Homebrew `samtools` can still exercise the code paths that locate a
tool on `PATH`, spawn it, parse its exit status and consume its output.

They are **test shims, not replacements**: only the argument subset the
extension uses is implemented (see each script's docstring), and anything else
exits 2 with `shim: unsupported` on stderr. Real tools report their failures
with a non-zero exit status and a message on stderr; the shims do the same.

## Usage

Create the venv once (also needed for the fixtures) and put both directories
on `PATH`, shims first so they shadow any real install you want to bypass:

```sh
python3 -m venv .venv
.venv/bin/pip install pysam pyBigWig numpy
export PATH="$PWD/test/tools/bin:$PWD/.venv/bin:$PATH"

samtools --version      # samtools 1.21-shim
bgzip --version         # bgzip (htslib) 1.21-shim
tabix --version         # tabix (htslib) 1.21-shim
```

The scripts use `#!/usr/bin/env python3`, so `.venv/bin` must precede any
system Python on `PATH` (or `pysam` must otherwise be importable). The
`-shim` suffix in the version strings makes it obvious in logs which binary
ran.

## Supported commands

| Tool | Forms |
| --- | --- |
| `samtools` | `--version`; `index [-b\|-c] [-m INT] [-@ N] FILE [OUT]`; `faidx FILE [REGION...]`; `view [-b] [-h] [-H] [-s SEED.FRAC] [-L BED] [-o OUT] [-@ N] [-T REF] [-q MAPQ] [-f FLAG] [-F FLAG] FILE [REGION...]` |
| `bgzip` | `--version`; `[-c] [-f] [-@ N] [-l LEVEL] [FILE]` (stdin when no FILE); `-d [-c] [-f] [FILE.gz]` |
| `tabix` | `--version`; `-p vcf\|bed\|gff\|sam [-f] [-C] FILE.gz`; `-s S -b B -e E [-S N] [-0] [-f] FILE.gz`; `-l FILE.gz`; `-H FILE.gz`; `[-h] FILE.gz REGION...` |

`samtools index` and `samtools faidx` pass their arguments straight to the
samtools code bundled in pysam, so they behave like the real commands
(default outputs `FILE.bai`, `FILE.csi` with `-c`, `FILE.crai` for CRAM,
`FILE.fai`). `bgzip` without `-c` replaces `FILE` with `FILE.gz`, as the real
tool does; with `-c` or when reading stdin it writes to stdout and leaves the
input alone. `tabix -p` refuses to overwrite an existing index unless `-f` is
given and rejects input that is not BGZF, matching the real messages.

## Known deviations from the real tools

- `samtools view -s SEED.FRAC` keeps a read when `random.Random(SEED).random() < FRAC`,
  so the kept set differs from real samtools (which hashes read names), and
  paired reads are not kept together. Counts are still approximately `FRAC`
  of the input.
- `samtools view -@` and `-T` are parsed and ignored (single-threaded;
  CRAM input needs `-T` only if the reference is not resolvable otherwise).
- `samtools view -L` filters by overlap with the (merged) BED intervals while
  streaming; it does not require an index, like the real tool, but BED files
  with `track`/`browser` lines are tolerated rather than rejected.
- `bgzip` ignores `-l`/`-@`/`-i`/`-k` and refuses to overwrite without `-f`
  instead of prompting interactively.
- `tabix -s/-b/-e` columns are 1-based as in the real tool (converted to
  pysam's 0-based columns internally). `-m`, `-c`, `-@`, `-T` are accepted and
  ignored. Querying an unknown contig prints nothing, like real tabix.
- Help output and the exact wording of some error messages differ.
