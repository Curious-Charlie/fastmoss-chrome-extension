export function toCsv(rows) {
  return rows.map((row) => row.map(csvCell).join(',')).join('\n');
}

function csvCell(value) {
  const text = String(value ?? '');
  return `"${text.replaceAll('"', '""')}"`;
}
