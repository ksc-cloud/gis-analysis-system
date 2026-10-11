"""Grid hotspot statistics (app.services.hotspot_stats): Getis-Ord Gi*, global Moran's I, Benjamini-Hochberg.

Expected values come from hand calculation (3x3 grid) or from the plain-Python reference implementations below
(double loops over cells, math only), never from the functions under test.
"""

import math
import random
import time

import numpy as np
import pytest

from app.geo.grid import grid_cells
from app.services import hotspot_stats as hs


# ------------------------------------------------------------------------------------- reference implementations

def ref_neighbors(cells: list[tuple[int, int]]) -> list[list[int]]:
    """Queen neighbors (without self) by comparing every pair."""
    return [[j for j, (c2, r2) in enumerate(cells) if j != i and max(abs(c2 - c), abs(r2 - r)) == 1]
            for i, (c, r) in enumerate(cells)]


def ref_gi_star(cells, values) -> list[float | None]:
    """Gi* with binary weights including the cell itself; None where the denominator is zero."""
    n = len(values)
    mean = sum(values) / n
    s = math.sqrt(sum(v * v for v in values) / n - mean * mean)
    result = []
    for i, nb in enumerate(ref_neighbors(cells)):
        members = nb + [i]
        w = len(members)
        denominator = s * math.sqrt((n * w - w * w) / (n - 1)) if s > 0 else 0.0
        result.append(None if denominator == 0 else (sum(values[j] for j in members) - mean * w) / denominator)
    return result


def ref_moran(cells, values) -> float:
    """Moran's I with row-standardized weights (without self)."""
    n = len(values)
    mean = sum(values) / n
    z = [v - mean for v in values]
    numerator = sum(z[i] * z[j] / len(nb) for i, nb in enumerate(ref_neighbors(cells)) for j in nb)
    return numerator / sum(v * v for v in z)  # n / S0 = 1 with row-standardized weights


def ref_bh(p: list[float]) -> list[float]:
    """q_i = min over p_j >= p_i of m * p_j / rank_j (ties: highest rank), capped at 1."""
    m = len(p)
    ranked = sorted(p)
    q = []
    for value in p:
        candidates = [m * ranked[k] / (k + 1) for k in range(m) if ranked[k] >= value]
        q.append(min(1.0, min(candidates)))
    return q


def ref_permutation_p(observed: float, simulated: list[float], center: float) -> float:
    extreme = sum(1 for s in simulated if abs(s - center) >= abs(observed - center))
    return (extreme + 1) / (len(simulated) + 1)


def square(width: int, height: int | None = None) -> list[tuple[int, int]]:
    height = width if height is None else height
    return [(c, r) for r in range(height) for c in range(width)]


def adjacency(cells):
    return hs.queen_adjacency([c for c, _ in cells], [r for _, r in cells])


def analyze(cells, values, small=None, **options):
    return hs.analyze([c for c, _ in cells], [r for _, r in cells], values,
                      small if small is not None else [False] * len(cells), **options)


def circle_grid(radius=1000, size=50):
    """Cell layout of the real grid (app.geo.grid) and its smallBoundary flags (grid-density rule)."""
    cells = grid_cells(radius, size)
    small = [c.domain_area < c.cell_area - 1e-6 and c.domain_ratio < 0.25 for c in cells]
    return [(c.col, c.row) for c in cells], small


CENTER_ONLY = [1.0 if (c, r) == (1, 1) else 0.0 for c, r in square(3)]


# ------------------------------------------------------------------------------------------------ Queen weights

def test_queen_neighbor_counts_on_3x3():
    cells = square(3)
    adj = adjacency(cells)

    counts = dict(zip(cells, adj.counts.tolist()))
    assert counts == {(0, 0): 3, (2, 0): 3, (0, 2): 3, (2, 2): 3, (1, 0): 5, (0, 1): 5, (2, 1): 5, (1, 2): 5,
                      (1, 1): 8}
    assert adj.n == 9 and len(adj.source) == 40


def test_queen_adjacency_is_symmetric_and_matches_the_reference():
    cells, _ = circle_grid(500, 100)
    adj = adjacency(cells)

    edges = set(zip(adj.source.tolist(), adj.target.tolist()))
    assert edges == {(i, j) for i, nb in enumerate(ref_neighbors(cells)) for j in nb}
    assert edges == {(j, i) for i, j in edges}
    assert all(i != j for i, j in edges)
    assert list(zip(adj.source.tolist(), adj.target.tolist())) == sorted(edges)


def test_queen_adjacency_rejects_bad_positions():
    with pytest.raises(ValueError):
        hs.queen_adjacency([0, 0], [1, 1])  # duplicate cell
    with pytest.raises(ValueError):
        hs.queen_adjacency([0, 1], [0])  # lengths differ
    with pytest.raises(ValueError):
        hs.queen_adjacency([0, 1.5], [0, 0])  # not an integer position


# --------------------------------------------------------------------------------------------------------- Gi*

def test_gi_star_3x3_by_hand():
    """x = 1 only in the center: n = 9, mean 1/9, S = sqrt(8)/9.

    corner: W = 4 (self + 3), sum = 1 -> (1 - 4/9) / (S·sqrt((36 - 16)/8)) = 5/sqrt(20)
    edge:   W = 6 (self + 5), sum = 1 -> (1 - 6/9) / (S·sqrt((54 - 36)/8)) = 3/sqrt(18)
    center: W = 9 = n -> n·W - W² = 0, undefined
    """
    cells = square(3)
    gi = hs.gi_star(np.array(CENTER_ONLY), adjacency(cells))
    by_cell = dict(zip(cells, zip(gi.z.tolist(), gi.defined.tolist())))

    for corner in [(0, 0), (2, 0), (0, 2), (2, 2)]:
        assert by_cell[corner][1] and by_cell[corner][0] == pytest.approx(5 / math.sqrt(20), abs=1e-12)
    for edge in [(1, 0), (0, 1), (2, 1), (1, 2)]:
        assert by_cell[edge][1] and by_cell[edge][0] == pytest.approx(3 / math.sqrt(18), abs=1e-12)
    assert by_cell[(1, 1)][1] is False
    assert np.all(np.isfinite(gi.z))


@pytest.mark.parametrize("seed", [1, 2, 3, 4])
def test_gi_star_5x5_matches_the_reference(seed):
    cells = square(5)
    rnd = random.Random(seed)
    values = [rnd.random() ** 3 for _ in cells]

    gi = hs.gi_star(np.array(values), adjacency(cells))

    expected = ref_gi_star(cells, values)
    assert all(e is not None for e in expected)
    assert gi.defined.all()
    assert gi.z.tolist() == pytest.approx(expected, abs=1e-12)


def test_gi_star_hot_corner_block_on_5x5():
    cells = square(5)
    values = [1.0 if c <= 1 and r <= 1 else 0.0 for c, r in cells]
    z = dict(zip(cells, hs.gi_star(np.array(values), adjacency(cells)).z.tolist()))

    assert all(z[cell] > 2 for cell in [(0, 0), (1, 0), (0, 1), (1, 1)])
    assert z[(4, 4)] < 0
    assert z[(0, 0)] == pytest.approx(ref_gi_star(cells, values)[0], abs=1e-12)


def test_gi_star_constant_values_are_undefined_without_nan():
    cells = square(5)
    gi = hs.gi_star(np.full(25, 0.3), adjacency(cells))

    assert not gi.defined.any()
    assert np.all(np.isfinite(gi.z))


@pytest.mark.parametrize(("a", "b"), [(2.0, 0.0), (0.5, 3.0), (100.0, -7.0)])
def test_gi_star_and_moran_are_invariant_to_positive_linear_transforms(a, b):
    cells = square(5)
    rnd = random.Random(11)
    values = np.array([rnd.random() for _ in cells])
    adj = adjacency(cells)

    assert hs.gi_star(a * values + b, adj).z.tolist() == pytest.approx(hs.gi_star(values, adj).z.tolist(),
                                                                      abs=1e-9)
    assert hs.gi_star(-a * values + b, adj).z.tolist() == pytest.approx((-hs.gi_star(values, adj).z).tolist(),
                                                                       abs=1e-9)
    assert hs.morans_i(a * values + b, adj) == pytest.approx(hs.morans_i(values, adj), abs=1e-12)
    assert hs.morans_i(-a * values + b, adj) == pytest.approx(hs.morans_i(values, adj), abs=1e-12)


@pytest.mark.parametrize("transform", [
    lambda c, r: (-r, c),   # rotate 90°
    lambda c, r: (-c, -r),  # rotate 180°
    lambda c, r: (-c, r),   # mirror
    lambda c, r: (r, c),    # transpose
])
def test_rotating_or_mirroring_the_grid_moves_the_results_with_the_cells(transform):
    cells, _ = circle_grid(300, 50)
    rnd = random.Random(5)
    values = [rnd.random() ** 2 for _ in cells]
    moved = [transform(c, r) for c, r in cells]
    order = sorted(range(len(cells)), key=lambda i: (moved[i][1], moved[i][0]))  # another input order as well

    original = hs.gi_star(np.array(values), adjacency(cells)).z
    shuffled = hs.gi_star(np.array([values[i] for i in order]), adjacency([moved[i] for i in order])).z

    assert shuffled.tolist() == pytest.approx([original[i] for i in order], abs=1e-12)
    assert hs.morans_i(np.array([values[i] for i in order]), adjacency([moved[i] for i in order])) == \
        pytest.approx(hs.morans_i(np.array(values), adjacency(cells)), abs=1e-12)


# ------------------------------------------------------------------------------------------------- Moran's I

def test_moran_3x3_by_hand():
    """Row-standardized: I = Σ_i (1/k_i)·z_i·Σ_j z_j / Σ z² = (-96/405) / (360/405) = -4/15; E[I] = -1/8."""
    cells = square(3)
    i = hs.morans_i(np.array(CENTER_ONLY), adjacency(cells))

    assert i == pytest.approx(-4 / 15, abs=1e-12)
    assert ref_moran(cells, CENTER_ONLY) == pytest.approx(-4 / 15, abs=1e-12)
    assert hs.expected_morans_i(9) == pytest.approx(-1 / 8)


@pytest.mark.parametrize(("name", "values"), [
    ("gradient", lambda c, r: float(c)),
    ("checkerboard", lambda c, r: float((c + r) % 2)),
    ("stripes", lambda c, r: float(r % 2)),
    ("random", lambda c, r: random.Random(c * 31 + r).random()),
])
def test_moran_5x5_matches_the_reference(name, values):
    cells = square(5)
    x = [values(c, r) for c, r in cells]

    assert hs.morans_i(np.array(x), adjacency(cells)) == pytest.approx(ref_moran(cells, x), abs=1e-12)


def test_moran_of_several_samples_at_once_matches_the_reference():
    cells = square(5)
    rnd = random.Random(8)
    samples = [[rnd.random() for _ in cells] for _ in range(6)]

    many = hs.morans_i(np.array(samples), adjacency(cells))

    assert many.tolist() == pytest.approx([ref_moran(cells, s) for s in samples], abs=1e-12)


def test_moran_gradient_is_strongly_positive_and_the_hot_block_above_expectation():
    cells = square(5)
    adj = adjacency(cells)

    assert hs.morans_i(np.array([float(c) for c, _ in cells]), adj) > 0.5
    block = np.array([1.0 if c <= 1 and r <= 1 else 0.0 for c, r in cells])
    assert hs.morans_i(block, adj) > hs.expected_morans_i(25)


def test_moran_rejects_constant_values_and_cells_without_neighbors():
    with pytest.raises(ValueError):
        hs.morans_i(np.full(9, 2.0), adjacency(square(3)))
    with pytest.raises(ValueError):
        hs.morans_i(np.array([0.0, 1.0, 2.0]), adjacency([(0, 0), (1, 0), (5, 5)]))


# ------------------------------------------------------------------------------------------- permutation test

def test_permutation_p_value_formula():
    # center 0, observed 0.4: only |0.5| >= 0.4 -> (1 + 1) / (5 + 1)
    assert hs.permutation_p_value(0.4, np.array([-0.3, -0.1, 0.0, 0.2, 0.5]), 0.0) == pytest.approx(2 / 6)
    # The other side counts as well: |-0.45| >= 0.4 -> (2 + 1) / (5 + 1)
    assert hs.permutation_p_value(0.4, np.array([-0.45, -0.1, 0.0, 0.2, 0.5]), 0.0) == pytest.approx(3 / 6)
    assert hs.permutation_p_value(0.4, np.array([-0.45, -0.1, 0.0, 0.2, 0.5]), 0.0) == \
        pytest.approx(ref_permutation_p(0.4, [-0.45, -0.1, 0.0, 0.2, 0.5], 0.0))
    # Deviations are measured from the center, not from zero: 0.1 is 0.2 away from -0.1, the simulations 0.
    assert hs.permutation_p_value(0.1, np.array([-0.1, -0.1, -0.1]), -0.1) == pytest.approx(1 / 4)
    # A tie counts as extreme (conservative), also when float noise makes the simulation a hair smaller.
    assert 0.3 - 1e-16 < 0.3
    assert hs.permutation_p_value(0.3, np.array([0.3 - 1e-16, 0.0]), 0.0) == pytest.approx(2 / 3)


def test_permutation_p_value_range_and_minimum():
    sims = np.linspace(-0.1, 0.1, 999)
    assert hs.permutation_p_value(5.0, sims, 0.0) == pytest.approx(1 / 1000)  # never 0: the observed counts too
    assert hs.permutation_p_value(0.0, sims, 0.0) == 1.0


@pytest.mark.parametrize("permutations", hs.PERMUTATION_CHOICES)
def test_moran_permutation_test_of_a_strong_pattern_has_the_minimum_p(permutations):
    cells = square(8)
    values = np.array([float(c) for c, _ in cells])
    result = hs.moran_permutation_test(values, adjacency(cells), permutations=permutations)

    assert result.permutations == permutations and len(result.simulated) == permutations
    assert result.p_value == pytest.approx(1 / (permutations + 1))
    assert result.i == pytest.approx(ref_moran(cells, values.tolist()), abs=1e-12)
    assert result.expected == pytest.approx(-1 / 63)
    assert result.z_simulated > 5


def test_moran_permutation_p_matches_the_reference_formula_on_its_own_simulations():
    cells = square(7)
    rnd = random.Random(21)
    values = np.array([rnd.random() for _ in cells])
    result = hs.moran_permutation_test(values, adjacency(cells), permutations=999)

    sims = result.simulated.tolist()
    assert result.p_value == pytest.approx(ref_permutation_p(result.i, sims, -1 / 48))
    assert (result.p_value * 1000) == pytest.approx(round(result.p_value * 1000))  # a multiple of 1/(P+1)
    assert 1 / 1000 <= result.p_value <= 1
    assert result.simulated_mean == pytest.approx(sum(sims) / len(sims))
    # Every simulation is the Moran's I of a permutation of the same values: bounded like I itself.
    assert all(-1.5 < s < 1.5 for s in sims)


def test_moran_permutations_are_centered_on_the_exact_expectation():
    """Under total randomization E[I] = -1/(n-1) exactly; the mean of 9999 simulations is close to it."""
    cells, _ = circle_grid(500, 100)
    rnd = random.Random(3)
    values = np.array([rnd.random() for _ in cells])
    result = hs.moran_permutation_test(values, adjacency(cells), permutations=9999)

    assert result.simulated_mean == pytest.approx(result.expected, abs=4 * result.simulated_sd / math.sqrt(9999))


def test_moran_permutation_test_is_reproducible_with_a_fixed_seed():
    cells = square(6)
    rnd = random.Random(4)
    values = np.array([rnd.random() for _ in cells])
    adj = adjacency(cells)

    first = hs.moran_permutation_test(values, adj, permutations=999, seed=7)
    again = hs.moran_permutation_test(values, adj, permutations=999, seed=7)
    other = hs.moran_permutation_test(values, adj, permutations=999, seed=8)

    assert first.simulated.tolist() == again.simulated.tolist() and first.p_value == again.p_value
    assert first.simulated.tolist() != other.simulated.tolist()
    assert hs.moran_permutation_test(values, adj).seed == hs.DEFAULT_SEED


@pytest.mark.parametrize("permutations", [0, 100, 1000, -999, 999.0, True, "999"])
def test_only_the_allowed_permutation_counts(permutations):
    with pytest.raises(ValueError):
        hs.moran_permutation_test(np.arange(9.0), adjacency(square(3)), permutations=permutations)


@pytest.mark.parametrize("seed", [-1, 1.5, True, "1", None])
def test_seed_must_be_a_non_negative_integer(seed):
    with pytest.raises(ValueError):
        hs.moran_permutation_test(np.arange(9.0), adjacency(square(3)), seed=seed)


# --------------------------------------------------------------------------------------- Benjamini-Hochberg

def test_bh_example_of_benjamini_hochberg_1995():
    """The 15 p-values of the original paper: BH rejects 4 at q = 0.05 (Bonferroni 3)."""
    p = [0.0001, 0.0004, 0.0019, 0.0095, 0.0201, 0.0278, 0.0298, 0.0344, 0.0459, 0.3240, 0.4262, 0.5719, 0.6528,
         0.7590, 1.0]
    q = hs.bh_adjust(np.array(p))

    assert sum(1 for v in q if v <= 0.05) == 4
    assert sum(1 for v in p if v <= 0.05 / len(p)) == 3
    assert q.tolist() == pytest.approx(ref_bh(p), abs=1e-15)


def test_bh_keeps_the_input_order_and_handles_ties_and_bounds():
    p = [0.04, 0.01, 0.04, 1.0, 0.0, 0.03, 0.04]
    q = hs.bh_adjust(np.array(p)).tolist()

    assert q == pytest.approx(ref_bh(p), abs=1e-15)
    assert q[0] == q[2] == q[6]  # tied p-values get the same q
    assert all(a >= b for a, b in zip(q, p))  # q >= p
    assert all(0 <= v <= 1 for v in q)
    assert q[4] == 0.0 and q[3] == 1.0
    by_p = sorted(zip(p, q))
    assert all(a[1] <= b[1] for a, b in zip(by_p, by_p[1:]))  # monotone in p


def test_bh_single_and_empty():
    assert hs.bh_adjust(np.array([0.03])).tolist() == [0.03]
    assert hs.bh_adjust(np.array([])).tolist() == []


@pytest.mark.parametrize("bad", [[0.1, float("nan")], [0.1, -0.01], [1.2], [float("inf")]])
def test_bh_rejects_invalid_p_values(bad):
    with pytest.raises(ValueError):
        hs.bh_adjust(np.array(bad))


# ------------------------------------------------------------------------------------------------ classification

@pytest.mark.parametrize(("z", "q", "expected"), [
    (2.0, 0.01, ("HOT_99", 3)),
    (2.0, 0.010000001, ("HOT_95", 2)),
    (2.0, 0.05, ("HOT_95", 2)),
    (2.0, 0.050000001, ("HOT_90", 1)),
    (2.0, 0.10, ("HOT_90", 1)),
    (2.0, 0.100000001, ("NOT_SIGNIFICANT", 0)),
    (-2.0, 0.001, ("COLD_99", -3)),
    (-2.0, 0.03, ("COLD_95", -2)),
    (-2.0, 0.07, ("COLD_90", -1)),
    (-2.0, 0.5, ("NOT_SIGNIFICANT", 0)),
    (0.0, 0.0, ("NOT_SIGNIFICANT", 0)),
])
def test_classify_thresholds(z, q, expected):
    assert hs.classify(z, q) == expected


def test_normal_two_sided_p():
    p = hs.normal_two_sided_p(np.array([0.0, 1.959963984540054, -2.5758293035489004, 40.0]))

    assert p.tolist() == pytest.approx([1.0, 0.05, 0.01, 0.0], abs=1e-12)


# --------------------------------------------------------------------------------------------------- analyze()

def test_analyze_classifies_only_by_the_bh_q_of_tested_cells():
    cells, small = circle_grid(1000, 50)
    rnd = random.Random(12)
    values = [rnd.random() * 0.2 for _ in cells]
    # A dense cluster in the north-east and an empty patch in the south-west.
    for k, (c, r) in enumerate(cells):
        if 8 <= c <= 11 and 8 <= r <= 11:
            values[k] = 0.8 + rnd.random() * 0.1
        if -11 <= c <= -8 and -11 <= r <= -8:
            values[k] = 0.0
    result = analyze(cells, values, small)

    assert result.status == "OK"
    tested = [cell for cell in result.cells if cell.hotspot_class != "NOT_TESTED"]
    assert result.tested_cell_count == len(tested) == sum(1 for s in small if not s)
    # BH over the tested cells only, from their two-sided normal p-values.
    q = ref_bh([cell.p_value for cell in tested])
    assert [cell.q_value for cell in tested] == pytest.approx(q, abs=1e-15)
    for cell in tested:
        assert cell.p_value == pytest.approx(math.erfc(abs(cell.z) / math.sqrt(2)), abs=1e-15)
        assert (cell.hotspot_class, cell.bin) == hs.classify(cell.z, cell.q_value)
        if cell.hotspot_class.startswith(("HOT", "COLD")):
            assert cell.q_value <= 0.10
    by_cell = dict(zip(cells, result.cells))
    assert by_cell[(9, 9)].hotspot_class == "HOT_99"
    assert by_cell[(-9, -9)].hotspot_class.startswith("COLD")
    assert result.moran is not None and result.moran.i > result.moran.expected
    assert result.moran.permutations == 999 and result.seed == hs.DEFAULT_SEED


def test_raw_p_below_005_is_not_a_hotspot_when_bh_does_not_reject():
    cells = square(10)
    rnd = random.Random(2)
    values = [rnd.random() for _ in cells]
    result = analyze(cells, values)

    nominal = [cell for cell in result.cells if cell.p_value is not None and cell.p_value < 0.05]
    assert nominal, "the data must contain nominally significant cells for this test"
    assert all(cell.q_value > 0.10 and cell.hotspot_class == "NOT_SIGNIFICANT" for cell in nominal)
    assert result.summary["NOT_SIGNIFICANT"] == 100


def test_null_data_rarely_produces_any_hotspot():
    """iid values (global null): BH keeps P(any rejection) <= q under independence or positive dependence.

    200 fields of 1289 tested cells, q = 0.10: expected at most 20 fields with a rejection; 35 is about
    +3.5 binomial standard deviations (sqrt(200·0.1·0.9) ≈ 4.2).
    """
    cells, small = circle_grid(1000, 50)
    with_rejection = 0
    false_cells = 0
    for seed in range(200):
        rng = np.random.default_rng(1000 + seed)
        result = analyze(cells, rng.random(len(cells)).tolist(), small, permutations=99)
        hits = sum(1 for cell in result.cells if cell.hotspot_class.startswith(("HOT", "COLD")))
        with_rejection += hits > 0
        false_cells += hits
    assert with_rejection <= 35
    assert false_cells / (200 * 1289) < 0.002


def test_small_boundary_cells_are_neither_tested_nor_neighbors():
    cells = square(6, 7)  # 42 cells
    small = [c == 5 for c, _ in cells]  # the east column
    rnd = random.Random(9)
    values = [rnd.random() for _ in cells]
    result = analyze(cells, values, small)

    by_cell = dict(zip(cells, result.cells))
    assert all(by_cell[(5, r)].hotspot_class == "NOT_TESTED" and by_cell[(5, r)].reason == "SMALL_BOUNDARY"
               and by_cell[(5, r)].z is None and by_cell[(5, r)].bin is None for r in range(7))
    assert by_cell[(4, 3)].neighbor_count == 5  # (5, *) is not a neighbor
    kept = [(c, r) for c, r in cells if c != 5]
    kept_values = [v for (c, _), v in zip(cells, values) if c != 5]
    expected = ref_gi_star(kept, kept_values)
    assert [by_cell[cell].z for cell in kept] == pytest.approx(expected, abs=1e-12)
    assert result.moran.i == pytest.approx(ref_moran(kept, kept_values), abs=1e-12)
    assert result.tested_cell_count == 35 and result.summary["NOT_TESTED"] == 7  # 42 - 7


def test_isolated_cells_are_not_tested_and_not_in_the_study_set():
    cells = square(6) + [(20, 20), (-9, 3)]  # two cells without any queen neighbor
    rnd = random.Random(10)
    values = [rnd.random() for _ in cells]
    result = analyze(cells, values)

    by_cell = dict(zip(cells, result.cells))
    for isolated in [(20, 20), (-9, 3)]:
        assert by_cell[isolated].hotspot_class == "NOT_TESTED" and by_cell[isolated].reason == "NO_NEIGHBORS"
        assert by_cell[isolated].neighbor_count == 0
    # Their values are not part of the mean and spread either.
    assert [by_cell[c].z for c in square(6)] == pytest.approx(ref_gi_star(square(6), values[:36]), abs=1e-12)
    assert result.tested_cell_count == 36


def test_cell_becoming_isolated_by_small_boundary_neighbors():
    cells = square(6) + [(7, 0)]
    small = [False] * 36 + [False]
    cells.append((6, 0))
    small.append(True)  # (6, 0) links (7, 0) to the grid, but it is excluded
    values = [float(i % 5) for i in range(len(cells))]
    result = analyze(cells, values, small)

    by_cell = dict(zip(cells, result.cells))
    assert by_cell[(7, 0)].reason == "NO_NEIGHBORS"
    assert by_cell[(6, 0)].reason == "SMALL_BOUNDARY"


def test_undefined_variance_cell_is_reported_by_the_low_level_reason():
    """W_i = n cannot happen with 30+ cells and at most 9 Queen members; the 3x3 center shows the rule."""
    gi = hs.gi_star(np.array(CENTER_ONLY), adjacency(square(3)))
    reasons = hs.untested_reasons(gi, adjacency(square(3)))

    assert reasons[4] == "UNDEFINED_VARIANCE"
    assert [r for k, r in enumerate(reasons) if k != 4] == [None] * 8


@pytest.mark.parametrize(("width", "height", "status"), [(5, 6, "OK"), (29, 1, "INSUFFICIENT_CELLS"),
                                                        (30, 1, "OK")])
def test_minimum_tested_cells_boundary(width, height, status):
    cells = square(width, height)
    values = [float((c * 7 + r * 3) % 5) for c, r in cells]
    result = analyze(cells, values)

    assert len(cells) in (29, 30)
    assert result.status == status
    if status == "INSUFFICIENT_CELLS":
        assert result.moran is None and result.tested_cell_count == 0
        assert all(cell.hotspot_class == "NOT_TESTED" and cell.reason == "INSUFFICIENT_CELLS" and cell.z is None
                   for cell in result.cells)
    else:
        assert result.tested_cell_count == 30


def test_minimum_counts_cells_after_exclusions():
    cells = square(6)  # 36 cells
    small = [c == 0 for c, _ in cells]  # 6 excluded -> 30 left
    values = [float((c * 7 + r * 3) % 5) for c, r in cells]
    assert analyze(cells, values, small).status == "OK"
    small = [c == 0 or (c, r) == (1, 0) for c, r in cells]  # 29 left
    result = analyze(cells, values, small)
    assert result.status == "INSUFFICIENT_CELLS"
    assert dict(zip(cells, result.cells))[(0, 0)].reason == "SMALL_BOUNDARY"


@pytest.mark.parametrize("value", [0.0, 0.42])
def test_constant_values_are_not_testable(value):
    cells = square(8)
    result = analyze(cells, [value] * 64)

    assert result.status == "CONSTANT_VALUES"
    assert result.moran is None and result.tested_cell_count == 0
    assert all(cell.hotspot_class == "NOT_TESTED" and cell.reason == "CONSTANT_VALUES" and cell.z is None
               and cell.p_value is None and cell.q_value is None for cell in result.cells)


def test_constant_among_tested_cells_even_if_excluded_cells_differ():
    cells = square(8)
    small = [c == 0 for c, _ in cells]
    values = [0.9 if c == 0 else 0.1 for c, _ in cells]
    result = analyze(cells, values, small)

    assert result.status == "CONSTANT_VALUES"


@pytest.mark.parametrize("bad", [float("nan"), float("inf"), float("-inf")])
def test_non_finite_values_are_rejected(bad):
    cells = square(6)
    values = [0.1] * 36
    values[7] = bad
    with pytest.raises(ValueError):
        analyze(cells, values)
    with pytest.raises(ValueError):
        hs.gi_star(np.array(values), adjacency(cells))


@pytest.mark.parametrize("bad", [
    {"values": [0.1] * 35},           # length mismatch
    {"small": [False] * 35},          # length mismatch
    {"values": ["0.1"] * 36},         # not numbers
    {"small": [0] * 36},              # not booleans
])
def test_invalid_inputs_are_rejected(bad):
    cells = square(6)
    with pytest.raises(ValueError):
        analyze(cells, bad.get("values", [0.1] * 36), bad.get("small", [False] * 36))


def test_sparse_values_warning():
    cells = square(6)  # 36 tested cells
    four = [1.0 if k in (0, 7, 14, 21) else 0.0 for k in range(36)]  # 11.1 % non-zero
    three = [1.0 if k in (0, 7, 14) else 0.0 for k in range(36)]  # 8.3 % non-zero

    assert "SPARSE_VALUES" not in analyze(cells, four).warnings
    assert "SPARSE_VALUES" in analyze(cells, three).warnings
    assert analyze(cells, three).status == "OK"


def test_sparse_boundary_is_strictly_below_ten_percent():
    cells = square(10, 4)  # 40 cells, 4 non-zero = exactly 10 %
    values = [1.0 if k in (0, 11, 22, 33) else 0.0 for k in range(40)]

    assert "SPARSE_VALUES" not in analyze(cells, values).warnings
    values[33] = 0.0
    assert "SPARSE_VALUES" in analyze(cells, values).warnings


def test_sparse_counts_tested_cells_only():
    cells = square(6, 7)
    small = [c == 5 for c, _ in cells]  # 35 tested
    values = [1.0 if (c == 5 or k in (0, 7)) else 0.0 for k, (c, _) in enumerate(cells)]

    assert "SPARSE_VALUES" in analyze(cells, values, small).warnings


def test_summary_counts_every_class():
    cells, small = circle_grid(500, 50)
    rnd = random.Random(30)
    values = [0.9 if (c > 3 and r > 3) else rnd.random() * 0.1 for c, r in cells]
    result = analyze(cells, values, small)

    counted = {}
    for cell in result.cells:
        counted[cell.hotspot_class] = counted.get(cell.hotspot_class, 0) + 1
    assert result.summary == {name: counted.get(name, 0) for name in hs.CLASSES}
    assert sum(result.summary.values()) == len(cells)


def test_analyze_is_deterministic():
    cells, small = circle_grid(500, 50)
    rnd = random.Random(31)
    values = [rnd.random() for _ in cells]

    assert analyze(cells, values, small) == analyze(cells, values, small)


# ----------------------------------------------------------------------------------------------- performance

@pytest.mark.parametrize("permutations", [999, 9999])
def test_1345_cells_1km(record_property, permutations):
    cells, small = circle_grid(1000, 50)
    assert len(cells) == 1345
    rng = np.random.default_rng(99)
    values = rng.beta(0.5, 2.0, len(cells)).tolist()

    started = time.perf_counter()
    result = analyze(cells, values, small, permutations=permutations)
    elapsed = time.perf_counter() - started
    record_property("seconds", round(elapsed, 4))
    print(f"\nhotspot 1345 cells, {permutations} permutations: {elapsed * 1000:.1f} ms")

    assert result.status == "OK" and result.tested_cell_count == 1289
    assert elapsed < 10
