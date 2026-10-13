/**
 * The memory backend contract (spec B seam, M0 shape).
 *
 * A backend observes completed generation turns and answers recall queries
 * plus the long-term-memory prompt section. The degenerate implementation
 * ({@link ./degenerate.ts}) proves the seam; spec B (honcho mapping)
 * replaces it without touching the harness wiring.
 */
export {};
