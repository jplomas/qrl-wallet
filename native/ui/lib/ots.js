export function decimalToBinary(decimal) {
  const binary = [];
  let value = Number(decimal) || 0;
  for (let i = 0; i < 8; i += 1) {
    binary.push(value % 2);
    value = Math.floor(value / 2);
  }
  return binary;
}

export function parseOtsBitfield(otsResponse, totalSignatures = 1024) {
  const keys = {};
  const pages = (otsResponse && otsResponse.ots_bitfield_by_page) || [];
  const page = pages[0] || {};
  let bitfield = page.ots_bitfield || [];
  if (!Array.isArray(bitfield)) bitfield = [];

  bitfield.forEach((item, index) => {
    let decimal = 0;
    if (typeof item === 'number') decimal = item;
    else if (typeof item === 'string') {
      // Serialized as hex byte(s)
      const hex = item.length >= 2 ? item.slice(0, 2) : item;
      decimal = parseInt(hex, 16) || 0;
    } else if (item && item[0] != null) {
      decimal = item[0];
    }
    const bits = decimalToBinary(decimal).reverse();
    const startIndex = index * 8;
    for (let i = 0; i < 8; i += 1) {
      const otsIndex = startIndex + i;
      if (otsIndex < totalSignatures) {
        keys[otsIndex] = bits[i];
      }
    }
  });

  return {
    keys,
    nextKey: otsResponse && otsResponse.next_unused_ots_index != null
      ? Number(otsResponse.next_unused_ots_index)
      : null,
    found: otsResponse && otsResponse.unused_ots_index_found,
  };
}

export function otsIndexUsed(keys, index) {
  const value = keys && keys[index];
  return value === 1 || value === '1' || value === true;
}

export function otsKeysRemaining(keys, totalSignatures) {
  let used = 0;
  for (let i = 0; i < totalSignatures; i += 1) {
    if (otsIndexUsed(keys, i)) used += 1;
  }
  return Math.max(0, totalSignatures - used);
}

export function totalSignaturesForHeight(height) {
  const h = Number(height);
  if (!Number.isInteger(h) || h < 1 || h > 20) return 1024;
  return 2 ** h;
}
