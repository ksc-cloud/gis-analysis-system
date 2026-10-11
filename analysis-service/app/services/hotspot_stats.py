"""Hotspot statistics on the grid cells of one radius analysis. Pure computation: NumPy only, no FastAPI, no I/O.

The variable is the cell coverageRatio of grid-density; cells are identified by their integer grid position
(col, row) of app.geo.grid. Neighbors are Queen contiguity: the up to 8 cells with max(|Δcol|, |Δrow|) = 1.

Local: Getis-Ord Gi* (Ord & Getis 1995), binary weights including the cell itself (w_ii = 1)::

    x̄ = Σx / n,  S = sqrt(Σx² / n − x̄²),  W_i = Σ_j w_ij = k_i + 1  (binary, so Σ_j w_ij² = W_i)
    G*_i = (Σ_j w_ij x_j − x̄·W_i) / (S · sqrt((n·W_i − W_i²) / (n − 1)))

G*_i is a z-score; its p-value is the two-sided normal approximation p = erfc(|G*_i| / √2). A cell whose
denominator is zero (S = 0, or W_i = n: every cell is its neighbor) has no G*_i; it is never 0, NaN or inf.

Global: Moran's I, row-standardized weights without the cell itself (w_ij = 1/k_i, so S0 = n)::

    z = x − x̄,  I = (n / S0) · Σ_i Σ_j w_ij z_i z_j / Σ z²,  E[I] = −1 / (n − 1)

with a permutation test (see permutation_p_value).

Multiple testing: Benjamini-Hochberg over the tested cells only, q_(k) = min_{j ≥ k} m·p_(j) / j. BH controls the
false discovery rate for independent or positively dependent (PRDS) tests. Neighboring Gi* share data and are
positively correlated, which is the case BH is usually applied to (Caldas de Castro & Singer 2006), but PRDS is
not proven for every weight and value pattern: the FDR level is nominal, not a guarantee.

Classes by the BH q-value and the sign of G*_i: HOT/COLD_99 (q ≤ 0.01), _95 (q ≤ 0.05), _90 (q ≤ 0.10),
NOT_SIGNIFICANT (tested, q > 0.10) and NOT_TESTED. A cell that was not tested or is not significant is never a
hot or cold spot.
"""

import math
from dataclasses import dataclass, field
from numbers import Integral, Real

import numpy as np

#: Allowed permutation counts of the Moran's I test. With P permutations the smallest p-value is 1 / (P + 1).
PERMUTATION_CHOICES = (99, 999, 9999)
DEFAULT_PERMUTATIONS = 999

#: Fixed default seed (numpy.random.default_rng, PCG64): the same input gives the same result.
DEFAULT_SEED = 20261012

#: Fewer tested cells than this: no statistics (status INSUFFICIENT_CELLS).
MIN_TESTED_CELLS = 30

#: A SPARSE_VALUES warning when fewer than this share of the tested cells has a non-zero value.
SPARSE_NONZERO_RATIO = 0.10

#: Values whose range (max − min) is at most this are constant: S = 0, nothing can be tested.
CONSTANT_TOLERANCE = 1e-12

#: (q-value limit, confidence %, bin): the strictest level first.
LEVELS = ((0.01, 99, 3), (0.05, 95, 2), (0.10, 90, 1))

CLASSES = ("HOT_99", "HOT_95", "HOT_90", "NOT_SIGNIFICANT", "COLD_90", "COLD_95", "COLD_99", "NOT_TESTED")

#: Statuses of analyze().
OK, CONSTANT_VALUES, INSUFFICIENT_CELLS = "OK", "CONSTANT_VALUES", "INSUFFICIENT_CELLS"

#: Reasons of a NOT_TESTED cell (besides the status, CONSTANT_VALUES or INSUFFICIENT_CELLS, for cells that
#: would have been tested).
SMALL_BOUNDARY, NO_NEIGHBORS, UNDEFINED_VARIANCE = "SMALL_BOUNDARY", "NO_NEIGHBORS", "UNDEFINED_VARIANCE"

SPARSE_VALUES = "SPARSE_VALUES"

#: Permutations evaluated at once (a chunk × edges array, about 10 MB at 1 km / 50 m).
_PERMUTATION_CHUNK = 128


# ------------------------------------------------------------------------------------------------ data types

@dataclass(frozen=True, eq=False)
class Adjacency:
    """Queen neighbors of n cells as directed edges source → target (both directions, no self), sorted by
    (source, target); counts[i] = number of neighbors k_i."""

    n: int
    source: np.ndarray
    target: np.ndarray
    counts: np.ndarray


@dataclass(frozen=True, eq=False)
class GiStar:
    """z[i] = G*_i where defined[i]; z[i] = 0.0 (not a statistic) where the denominator is zero."""

    z: np.ndarray
    defined: np.ndarray


@dataclass(frozen=True)
class MoranTest:
    """
    i: observed Moran's I; expected: E[I] = −1/(n − 1)
    p_value: permutation p-value (permutation_p_value, centered on ``expected``)
    simulated_mean / simulated_sd (ddof = 1) of the simulated I; z_simulated = (i − mean) / sd (None if sd = 0)
    simulated: the simulated I values (not part of equality)
    """

    i: float
    expected: float
    p_value: float
    permutations: int
    seed: int
    simulated_mean: float
    simulated_sd: float
    z_simulated: float | None
    simulated: np.ndarray = field(compare=False, repr=False)


@dataclass(frozen=True)
class CellResult:
    """
    neighbor_count: Queen neighbors among the cells that are not small boundary cells (None for those)
    z, p_value, q_value: G*_i, two-sided normal p, BH q (None unless tested)
    hotspot_class: one of CLASSES; bin: 3..−3 (0 NOT_SIGNIFICANT, None NOT_TESTED)
    reason: why the cell is NOT_TESTED (None otherwise)
    """

    neighbor_count: int | None
    z: float | None
    p_value: float | None
    q_value: float | None
    hotspot_class: str
    bin: int | None
    reason: str | None


@dataclass(frozen=True)
class HotspotStats:
    """
    status: OK, CONSTANT_VALUES or INSUFFICIENT_CELLS
    cells: one result per input cell, in input order
    study_cell_count: cells in the statistics (not small boundary, with neighbors); tested_cell_count: cells with
    a G*_i (the BH m)
    moran: global Moran's I test over the study cells (None unless status is OK)
    summary: number of cells per class (every class of CLASSES)
    warnings: SPARSE_VALUES
    """

    status: str
    cells: tuple[CellResult, ...]
    study_cell_count: int
    tested_cell_count: int
    moran: MoranTest | None
    summary: dict[str, int]
    warnings: tuple[str, ...]
    permutations: int
    seed: int


# ----------------------------------------------------------------------------------------------- weights

def queen_adjacency(cols, rows) -> Adjacency:
    """Queen neighbors of the given cells only (a cell not in the list is not a neighbor)."""
    positions = _positions(cols, rows)
    index = {position: i for i, position in enumerate(positions)}
    source: list[int] = []
    target: list[int] = []
    for i, (col, row) in enumerate(positions):
        for d_row in (-1, 0, 1):
            for d_col in (-1, 0, 1):
                j = index.get((col + d_col, row + d_row))
                if j is not None and j != i:
                    source.append(i)
                    target.append(j)
    source_a = np.array(source, dtype=np.int64)
    target_a = np.array(target, dtype=np.int64)
    order = np.lexsort((target_a, source_a))
    n = len(positions)
    return Adjacency(n=n, source=source_a[order], target=target_a[order],
                     counts=np.bincount(source_a, minlength=n).astype(np.int64))


# ------------------------------------------------------------------------------------------------- Gi*

def gi_star(values, adjacency: Adjacency) -> GiStar:
    """Getis-Ord G*_i of every cell (module docstring). Constant values: no cell is defined."""
    x = _values(values, adjacency.n)
    n = len(x)
    if n < 2 or _is_constant(x):
        return GiStar(z=np.zeros(n), defined=np.zeros(n, dtype=bool))
    weight = adjacency.counts.astype(np.float64) + 1.0  # W_i, self included
    local_sum = np.bincount(adjacency.source, weights=x[adjacency.target], minlength=n) + x
    mean = float(np.mean(x))
    spread = float(np.std(x))  # S, population (divides by n)
    variance_term = n * weight - weight * weight  # integers: exactly 0 when W_i = n
    defined = variance_term > 0
    z = np.zeros(n)
    z[defined] = ((local_sum[defined] - mean * weight[defined])
                  / (spread * np.sqrt(variance_term[defined] / (n - 1))))
    return GiStar(z=z, defined=defined)


def untested_reasons(gi: GiStar, adjacency: Adjacency) -> list[str | None]:
    """NO_NEIGHBORS (k_i = 0) or UNDEFINED_VARIANCE (no G*_i) per cell, None for a cell with a G*_i."""
    return [NO_NEIGHBORS if count == 0 else (None if defined else UNDEFINED_VARIANCE)
            for count, defined in zip(adjacency.counts.tolist(), gi.defined.tolist())]


def normal_two_sided_p(z) -> np.ndarray:
    """p = P(|N(0, 1)| ≥ |z|) = erfc(|z| / √2)."""
    return np.array([math.erfc(abs(v) / math.sqrt(2.0)) for v in np.asarray(z, dtype=np.float64).tolist()])


# ---------------------------------------------------------------------------------------------- Moran's I

def morans_i(values, adjacency: Adjacency):
    """Moran's I with row-standardized Queen weights. ``values``: one sample (1-D, returns a float) or several
    samples as rows (2-D, returns an array). Every cell needs a neighbor and the values must not be constant."""
    x = _values(values, adjacency.n, samples=True)
    if adjacency.n < 2 or np.any(adjacency.counts == 0):
        raise ValueError("Moran's I needs at least two cells and a neighbor for every cell")
    z = x - x.mean(axis=-1, keepdims=True)
    if np.any(np.ptp(x, axis=-1) <= CONSTANT_TOLERANCE):
        raise ValueError("Moran's I is undefined for constant values")
    weights = 1.0 / adjacency.counts[adjacency.source]
    numerator = (z[..., adjacency.source] * z[..., adjacency.target]) @ weights
    result = numerator / np.sum(z * z, axis=-1)  # n / S0 = 1 with row-standardized weights
    return float(result) if result.ndim == 0 else result


def expected_morans_i(n: int) -> float:
    """E[I] = −1/(n − 1): the exact mean of I over all permutations of the values (any weights without self)."""
    return -1.0 / (n - 1)


def permutation_p_value(observed: float, simulated, center: float) -> float:
    """Two-sided permutation p-value, centered on the null expectation::

        p = (#{ |I_sim − c| ≥ |I_obs − c| } + 1) / (P + 1),  c = E[I] = −1/(n − 1)

    * Two-sided by distance from the center: a simulation is as extreme as the observation when it lies at least
      as far from c, on either side. c is the exact permutation mean E[I], not the sample mean of the simulations,
      so the center does not depend on the random draws.
    * Why not double the smaller tail, 2·min(#{I_sim ≥ I}, #{I_sim ≤ I}) / P: the distribution of I under
      permutation is skewed for small n or skewed values; doubling a tail assumes symmetry, can exceed 1 and
      treats the two tails as equally likely. The distance form is a valid test of |I − E[I]| for any shape.
      Its limit: on a skewed distribution "equally far" is not "equally rare" (the long tail is reached more
      easily), so it is a test of the size of the departure, not an equal-tailed test.
    * Finite-sample correction (+1 in numerator and denominator, Phipson & Smyth 2010): the observed arrangement
      is one of the permutations, so p is never 0; the smallest p is 1 / (P + 1).
    * Ties count as extreme (conservative), with a tolerance for floating-point noise of the vectorized sums.
    """
    sims = np.asarray(simulated, dtype=np.float64)
    deviation = abs(observed - center)
    tolerance = 1e-12 + 1e-9 * deviation
    extreme = int(np.count_nonzero(np.abs(sims - center) >= deviation - tolerance))
    return (extreme + 1) / (len(sims) + 1)


def moran_permutation_test(values, adjacency: Adjacency, permutations: int = DEFAULT_PERMUTATIONS,
                           seed: int = DEFAULT_SEED) -> MoranTest:
    """Moran's I and its permutation test: the values are shuffled over the cells (total randomization)
    ``permutations`` times with numpy.random.default_rng(seed)."""
    _check_permutations(permutations)
    _check_seed(seed)
    x = _values(values, adjacency.n)
    observed = morans_i(x, adjacency)
    expected = expected_morans_i(adjacency.n)
    rng = np.random.default_rng(seed)
    simulated = np.empty(permutations)
    for start in range(0, permutations, _PERMUTATION_CHUNK):
        size = min(_PERMUTATION_CHUNK, permutations - start)
        shuffled = rng.permuted(np.tile(x, (size, 1)), axis=1)
        simulated[start:start + size] = morans_i(shuffled, adjacency)
    mean = float(np.mean(simulated))
    sd = float(np.std(simulated, ddof=1))
    return MoranTest(i=observed, expected=expected, p_value=permutation_p_value(observed, simulated, expected),
                     permutations=permutations, seed=seed, simulated_mean=mean, simulated_sd=sd,
                     z_simulated=(observed - mean) / sd if sd > 0 else None, simulated=simulated)


# --------------------------------------------------------------------------------------- multiple testing

def bh_adjust(p_values) -> np.ndarray:
    """Benjamini-Hochberg adjusted p-values (q-values) in input order: q_(k) = min_{j ≥ k} m·p_(j)/j, at most 1.
    Tied p-values get the same q. Reject at level α where q ≤ α."""
    p = np.asarray(p_values, dtype=np.float64)
    if p.ndim != 1 or not np.all(np.isfinite(p)) or np.any(p < 0) or np.any(p > 1):
        raise ValueError("p-values must be a 1-D array of finite values in [0, 1]")
    m = len(p)
    if m == 0:
        return np.array([], dtype=np.float64)
    order = np.argsort(p, kind="stable")
    ranked = p[order] * m / np.arange(1, m + 1)
    q = np.empty(m)
    q[order] = np.minimum(np.minimum.accumulate(ranked[::-1])[::-1], 1.0)
    return q


def classify(z: float, q: float) -> tuple[str, int]:
    """Class and bin of a tested cell from its G*_i and BH q-value. q at a level counts as significant."""
    if z != 0:
        for limit, confidence, level_bin in LEVELS:
            if q <= limit:
                return ("HOT_" if z > 0 else "COLD_") + str(confidence), level_bin if z > 0 else -level_bin
    return "NOT_SIGNIFICANT", 0


# ----------------------------------------------------------------------------------------------- analyze

def analyze(cols, rows, values, small_boundary, *, permutations: int = DEFAULT_PERMUTATIONS,
            seed: int = DEFAULT_SEED) -> HotspotStats:
    """Gi* hotspots and the global Moran's I of the grid cells.

    1. Small boundary cells are left out: not tested and not a neighbor of any cell (SMALL_BOUNDARY).
    2. A remaining cell without a remaining Queen neighbor is left out as well (NO_NEIGHBORS); the rest is the
       study set (n cells): its values alone give x̄ and S.
    3. n < MIN_TESTED_CELLS: INSUFFICIENT_CELLS. Constant values in the study set: CONSTANT_VALUES. Then no cell is
       tested and there is no Moran's I.
    4. Gi* per study cell; cells without a G*_i are UNDEFINED_VARIANCE. BH over the tested cells only, classes
       by the q-value. Moran's I and its permutation test over the study set.
    """
    _check_permutations(permutations)
    _check_seed(seed)
    positions = _positions(cols, rows)
    total = len(positions)
    x = _values(values, total)
    small = _flags(small_boundary, total)

    candidates = np.flatnonzero(~small)
    candidate_adjacency = queen_adjacency([positions[i][0] for i in candidates],
                                          [positions[i][1] for i in candidates])
    neighbor_count: list[int | None] = [None] * total
    reasons: list[str | None] = [SMALL_BOUNDARY if s else None for s in small.tolist()]
    for i, count in zip(candidates.tolist(), candidate_adjacency.counts.tolist()):
        neighbor_count[i] = count
        if count == 0:
            reasons[i] = NO_NEIGHBORS
    # Removing cells without neighbors removes no edge: the study cells keep their neighbor counts.
    study = candidates[candidate_adjacency.counts > 0]
    adjacency = queen_adjacency([positions[i][0] for i in study], [positions[i][1] for i in study])
    study_values = x[study]
    n = len(study)

    z = p = q = None
    tested = np.array([], dtype=np.int64)
    moran = None
    if n < MIN_TESTED_CELLS:
        status = INSUFFICIENT_CELLS
    elif _is_constant(study_values):
        status = CONSTANT_VALUES
    else:
        gi = gi_star(study_values, adjacency)
        for local, reason in enumerate(untested_reasons(gi, adjacency)):
            if reason is not None:
                reasons[int(study[local])] = reason
        tested_local = np.flatnonzero(gi.defined)
        if len(tested_local) < MIN_TESTED_CELLS:
            status = INSUFFICIENT_CELLS
        else:
            status = OK
            tested = study[tested_local]
            z = gi.z[tested_local]
            p = normal_two_sided_p(z)
            q = bh_adjust(p)
            moran = moran_permutation_test(study_values, adjacency, permutations, seed)
    if status != OK:
        reasons = [reason if reason is not None else status for reason in reasons]

    cells: list[CellResult] = [CellResult(neighbor_count=neighbor_count[i], z=None, p_value=None, q_value=None,
                                          hotspot_class="NOT_TESTED", bin=None, reason=reasons[i])
                               for i in range(total)]
    for k, i in enumerate(tested.tolist()):
        hotspot_class, level_bin = classify(float(z[k]), float(q[k]))
        cells[i] = CellResult(neighbor_count=neighbor_count[i], z=float(z[k]), p_value=float(p[k]),
                              q_value=float(q[k]), hotspot_class=hotspot_class, bin=level_bin, reason=None)

    warnings: list[str] = []
    if status == OK and np.count_nonzero(x[tested]) < SPARSE_NONZERO_RATIO * len(tested):
        warnings.append(SPARSE_VALUES)
    summary = dict.fromkeys(CLASSES, 0)
    for cell in cells:
        summary[cell.hotspot_class] += 1
    return HotspotStats(status=status, cells=tuple(cells), study_cell_count=n, tested_cell_count=len(tested),
                        moran=moran, summary=summary, warnings=tuple(warnings), permutations=permutations,
                        seed=seed)


# ---------------------------------------------------------------------------------------------- validation

def _positions(cols, rows) -> list[tuple[int, int]]:
    cols, rows = list(cols), list(rows)
    if len(cols) != len(rows):
        raise ValueError("cols and rows must have the same length")
    positions = []
    for col, row in zip(cols, rows):
        if not (_is_int(col) and _is_int(row)):
            raise ValueError("cell positions must be integers")
        positions.append((int(col), int(row)))
    if len(set(positions)) != len(positions):
        raise ValueError("cell positions must be unique")
    return positions


def _values(values, n: int, samples: bool = False) -> np.ndarray:
    """Finite real values: one per cell (1-D), or rows of samples when ``samples`` (2-D allowed)."""
    if isinstance(values, np.ndarray):
        if values.dtype.kind not in "fiu":
            raise ValueError("values must be real numbers")
        x = values.astype(np.float64)
    else:
        x = list(values)
        if not all(isinstance(v, Real) and not isinstance(v, bool) for v in x):
            raise ValueError("values must be real numbers")
        x = np.array(x, dtype=np.float64)
    if x.ndim not in ((1, 2) if samples else (1,)) or x.shape[-1] != n:
        raise ValueError(f"values must have one value per cell ({n})")
    if not np.all(np.isfinite(x)):
        raise ValueError("values must be finite (no NaN or infinity)")
    return x


def _flags(flags, n: int) -> np.ndarray:
    flags = list(flags)
    if len(flags) != n or not all(isinstance(f, (bool, np.bool_)) for f in flags):
        raise ValueError(f"small_boundary must have one boolean per cell ({n})")
    return np.array(flags, dtype=bool)


def _is_int(value) -> bool:
    return isinstance(value, Integral) and not isinstance(value, (bool, np.bool_))


def _is_constant(x: np.ndarray) -> bool:
    return len(x) == 0 or float(np.ptp(x)) <= CONSTANT_TOLERANCE


def _check_permutations(permutations) -> None:
    if not _is_int(permutations) or permutations not in PERMUTATION_CHOICES:
        raise ValueError(f"permutations must be one of {', '.join(map(str, PERMUTATION_CHOICES))}")


def _check_seed(seed) -> None:
    if not _is_int(seed) or seed < 0:
        raise ValueError("seed must be a non-negative integer")
