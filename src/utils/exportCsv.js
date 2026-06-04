/**
 * exportCsv.js
 * Converts an array of objects to CSV and triggers a browser download.
 */
export function exportToCsv(filename, rows, columns) {
  if (!rows.length) return;

  const headers = columns.map((c) => c.label);
  const keys = columns.map((c) => c.key);

  const escape = (val) => {
    const str = val == null ? "" : String(val);
    return str.includes(",") || str.includes('"') || str.includes("\n")
      ? `"${str.replace(/"/g, '""')}"`
      : str;
  };

  const csvRows = [
    headers.map(escape).join(","),
    ...rows.map((row) => keys.map((k) => escape(row[k])).join(",")),
  ];

  const blob = new Blob([csvRows.join("\n")], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
