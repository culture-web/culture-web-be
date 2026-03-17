// Helper functions for Kathakali controller
const clampNumber = (value, min, max, fallback) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(max, Math.max(min, numeric));
};

const parseBoolean = (value, fallback = true) => {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true') return true;
    if (normalized === 'false') return false;
  }
  return fallback;
};

const bloomToNumber = (bloomLevel) => {
  const map = {
    '0_unseen': 0,
    '1_remember': 1,
    '2_understand': 2,
    '3_apply': 3,
    '4_analyze': 4,
  };
  return map[bloomLevel] ?? 0;
};

const numberToBloom = (n) => {
  const map = {
    0: '0_unseen',
    1: '1_remember',
    2: '2_understand',
    3: '3_apply',
    4: '4_analyze',
  };
  return map[n] || '0_unseen';
};

const validBloomLevels = new Set([
  '0_unseen',
  '1_remember',
  '2_understand',
  '3_apply',
  '4_analyze',
]);

module.exports = {
  clampNumber,
  parseBoolean,
  bloomToNumber,
  numberToBloom,
  validBloomLevels,
};
