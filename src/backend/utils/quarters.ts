/**
 * Indian fiscal year utilities.
 * FY runs April → March. FY label = year the FY ends.
 * e.g. FY26 = April 2025 → March 2026.
 *
 * Quarter map:
 *   Q1 = Apr–Jun  (ends Jun 30,  results ~Jul 15)
 *   Q2 = Jul–Sep  (ends Sep 30,  results ~Oct 15)
 *   Q3 = Oct–Dec  (ends Dec 31,  results ~Jan 15)
 *   Q4 = Jan–Mar  (ends Mar 31,  results ~Apr 15)
 */

export interface QuarterMeta {
  quarter: string;    // e.g. "Q2FY26"
  fiscalYear: number; // e.g. 2026
  publishedAt: string; // approximate ISO date results become available
}

// Calendar month (1-12) → which Q of the Indian FY we are currently in
function monthToQ(month: number): number {
  if (month >= 4 && month <= 6) return 1;
  if (month >= 7 && month <= 9) return 2;
  if (month >= 10 && month <= 12) return 3;
  return 4; // Jan–Mar
}

// FY-end year for a given calendar date
function fyEndYear(month: number, year: number): number {
  return month >= 4 ? year + 1 : year;
}

// Approximate publish date per quarter
function publishedAt(q: number, fyEnd: number): string {
  switch (q) {
    case 1: return `${fyEnd - 1}-07-15`; // Q1 ends Jun → results Jul
    case 2: return `${fyEnd - 1}-10-15`; // Q2 ends Sep → results Oct
    case 3: return `${fyEnd - 1}-12-31`; // Q3 ends Dec → results Jan (next cal year, fyEnd - 1 +1 = fyEnd)
    case 4: return `${fyEnd}-04-15`;     // Q4 ends Mar → results Apr
    default: return '';
  }
}

function quarterLabel(q: number, fyEnd: number): string {
  return `Q${q}FY${String(fyEnd).slice(-2)}`;
}

function prevQ(q: number, fyEnd: number): { q: number; fyEnd: number } {
  if (q === 1) return { q: 4, fyEnd: fyEnd - 1 };
  return { q: q - 1, fyEnd };
}

/**
 * Returns the last `n` completed Indian quarters as of `from` date.
 * "Completed" = results already published (quarter end + ~15 days).
 */
export function getLastNQuarters(n: number, from: Date = new Date()): QuarterMeta[] {
  const month = from.getMonth() + 1;
  const year = from.getFullYear();

  // Current quarter
  let curQ = monthToQ(month);
  let curFY = fyEndYear(month, year);

  // Check if current quarter's results are out yet (~15 days after quarter end)
  // Approximate quarter end dates:
  const quarterEndMonth: Record<number, number> = { 1: 6, 2: 9, 3: 12, 4: 3 };
  const endMonth = quarterEndMonth[curQ];
  const endYear = curQ === 4 ? curFY : curFY - 1;
  const resultsOut = from > new Date(`${endYear}-${String(endMonth).padStart(2, '0')}-15`);

  // If current quarter results aren't out, last completed = previous quarter
  if (!resultsOut) {
    ({ q: curQ, fyEnd: curFY } = prevQ(curQ, curFY));
  }

  const quarters: QuarterMeta[] = [];
  let q = curQ;
  let fyEnd = curFY;

  for (let i = 0; i < n; i++) {
    quarters.unshift({
      quarter: quarterLabel(q, fyEnd),
      fiscalYear: fyEnd,
      publishedAt: publishedAt(q, fyEnd),
    });
    ({ q, fyEnd } = prevQ(q, fyEnd));
  }

  return quarters;
}
