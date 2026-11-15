export interface SaqoReceiptData {
  reference: string;
  title: string;
  receiptType: 'Wallet Funding' | 'Wallet Transaction' | 'Delivery Payment' | 'Refund Receipt';
  amountNgn: number;
  status: string;
  paymentMethod: string;
  createdAt: string;
  customerName?: string | null;
  customerEmail?: string | null;
  customerPhone?: string | null;
  trackingCode?: string | null;
  providerTxId?: string | null;
  transferReference?: string | null;
  balanceBeforeNgn?: number;
  balanceAfterNgn?: number;
  description?: string | null;
  verifiedAt?: string | null;
}

function formatNairaAscii(amount: number): string {
  return `NGN ${Number(amount || 0).toLocaleString('en-NG', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function formatNairaDisplay(amount: number): string {
  return `₦${Number(amount || 0).toLocaleString('en-NG', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function formatReceiptDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('en-NG', {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function wrapLines(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    const test = line ? `${line} ${word}` : word;
    if (ctx.measureText(test).width > maxWidth && line) {
      lines.push(line);
      line = word;
    } else {
      line = test;
    }
  }
  if (line) lines.push(line);
  return lines.length > 0 ? lines : ['—'];
}

export function renderReceiptCanvas(data: SaqoReceiptData): HTMLCanvasElement {
  const width = 920;
  const rows: Array<[string, string]> = [
    ['Reference', data.reference],
    ['Receipt Type', data.receiptType],
    ['Status', data.status.replace(/_/g, ' ').toUpperCase()],
    ['Payment Method', data.paymentMethod.replace(/_/g, ' ').toUpperCase()],
    ['Date & Time', formatReceiptDate(data.createdAt)],
  ];
  if (data.customerName) rows.push(['Customer', data.customerName]);
  if (data.customerEmail) rows.push(['Email', data.customerEmail]);
  if (data.customerPhone) rows.push(['Phone', data.customerPhone]);
  if (data.trackingCode) rows.push(['Tracking Code', data.trackingCode]);
  if (data.providerTxId) rows.push(['Gateway Tx ID', data.providerTxId]);
  if (data.transferReference) rows.push(['Transfer Ref', data.transferReference]);
  if (data.balanceBeforeNgn !== undefined) {
    rows.push(['Balance Before', formatNairaDisplay(data.balanceBeforeNgn)]);
  }
  if (data.balanceAfterNgn !== undefined) {
    rows.push(['Balance After', formatNairaDisplay(data.balanceAfterNgn)]);
  }
  if (data.verifiedAt) rows.push(['Verified At', formatReceiptDate(data.verifiedAt)]);

  const descHeight = data.description ? 90 : 0;
  const height = 430 + rows.length * 54 + descHeight + 130;

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;

  // Crisp pure white background with black double border
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);

  ctx.strokeStyle = '#0a0a0a';
  ctx.lineWidth = 4;
  ctx.strokeRect(24, 24, width - 48, height - 48);

  // Header black band
  ctx.fillStyle = '#0a0a0a';
  ctx.fillRect(24, 24, width - 48, 138);

  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 34px "Space Grotesk", Arial, sans-serif';
  ctx.fillText('SAQO LOGISTICS', 60, 86);

  ctx.fillStyle = '#d4d4d4';
  ctx.font = '600 15px "JetBrains Mono", monospace';
  ctx.fillText('OFFICIAL PAYMENT & WALLET RECEIPT', 60, 122);

  // Status pill on right of header
  const badgeText = data.status.replace(/_/g, ' ').toUpperCase();
  ctx.font = 'bold 14px "JetBrains Mono", monospace';
  const badgeW = Math.max(130, ctx.measureText(badgeText).width + 38);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(width - 60 - badgeW, 66, badgeW, 40);
  ctx.fillStyle = '#0a0a0a';
  ctx.textAlign = 'center';
  ctx.fillText(badgeText, width - 60 - badgeW / 2, 92);
  ctx.textAlign = 'left';

  // Prominent Amount Block
  ctx.fillStyle = '#f5f5f5';
  ctx.fillRect(56, 192, width - 112, 136);
  ctx.strokeStyle = '#e5e5e5';
  ctx.lineWidth = 2;
  ctx.strokeRect(56, 192, width - 112, 136);

  ctx.fillStyle = '#525252';
  ctx.font = '600 14px "JetBrains Mono", monospace';
  ctx.fillText('TOTAL AMOUNT', 84, 232);

  ctx.fillStyle = '#0a0a0a';
  ctx.font = 'bold 52px "Space Grotesk", Arial, sans-serif';
  ctx.fillText(formatNairaDisplay(data.amountNgn), 84, 294);

  // Detail rows
  let y = 378;
  for (const [label, value] of rows) {
    ctx.fillStyle = '#525252';
    ctx.font = '600 15px "JetBrains Mono", monospace';
    ctx.fillText(label.toUpperCase(), 60, y);

    ctx.fillStyle = '#0a0a0a';
    ctx.font = 'bold 18px "JetBrains Mono", monospace';
    ctx.textAlign = 'right';
    ctx.fillText(String(value).slice(0, 42), width - 60, y);
    ctx.textAlign = 'left';

    ctx.strokeStyle = '#e5e5e5';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(60, y + 18);
    ctx.lineTo(width - 60, y + 18);
    ctx.stroke();

    y += 54;
  }

  if (data.description) {
    y += 8;
    ctx.fillStyle = '#525252';
    ctx.font = '600 14px "JetBrains Mono", monospace';
    ctx.fillText('NOTES / DESCRIPTION', 60, y);
    y += 28;
    ctx.fillStyle = '#0a0a0a';
    ctx.font = '500 18px Arial, sans-serif';
    const lines = wrapLines(ctx, data.description, width - 120).slice(0, 2);
    for (const line of lines) {
      ctx.fillText(line, 60, y);
      y += 26;
    }
  }

  // Footer
  ctx.strokeStyle = '#0a0a0a';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(60, height - 102);
  ctx.lineTo(width - 60, height - 102);
  ctx.stroke();

  ctx.fillStyle = '#525252';
  ctx.font = '500 14px "JetBrains Mono", monospace';
  ctx.fillText(`Verified Electronic Receipt · ${formatNairaAscii(data.amountNgn)}`, 60, height - 66);
  ctx.textAlign = 'right';
  ctx.fillText('saqo.ng', width - 60, height - 66);
  ctx.textAlign = 'left';

  return canvas;
}

export function downloadReceiptPng(data: SaqoReceiptData): void {
  const canvas = renderReceiptCanvas(data);
  const url = canvas.toDataURL('image/png');
  const a = document.createElement('a');
  a.href = url;
  a.download = `saqo-receipt-${data.reference}.png`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

function buildSingleImagePdfBlob(jpegBytes: Uint8Array, imgWidthPx: number, imgHeightPx: number): Blob {
  // Standard A4 portrait in points (595.28 x 841.89)
  const pageW = 595.28;
  const pageH = 841.89;
  const margin = 36;
  const availW = pageW - margin * 2;
  const availH = pageH - margin * 2;
  const scale = Math.min(availW / imgWidthPx, availH / imgHeightPx);
  const drawW = (imgWidthPx * scale).toFixed(2);
  const drawH = (imgHeightPx * scale).toFixed(2);
  const drawX = ((pageW - imgWidthPx * scale) / 2).toFixed(2);
  const drawY = (pageH - margin - imgHeightPx * scale).toFixed(2);

  const enc = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const offsets: number[] = [];
  let length = 0;

  const pushStr = (s: string) => {
    const b = enc.encode(s);
    chunks.push(b);
    length += b.length;
  };
  const pushBytes = (b: Uint8Array) => {
    chunks.push(b);
    length += b.length;
  };

  pushStr('%PDF-1.4\n');
  pushBytes(new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]));

  // 1: Catalog
  offsets.push(length);
  pushStr('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');

  // 2: Pages
  offsets.push(length);
  pushStr('2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n');

  // 3: Page
  offsets.push(length);
  pushStr(
    `3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageW} ${pageH}] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>\nendobj\n`
  );

  // 4: Image XObject
  offsets.push(length);
  pushStr(
    `4 0 obj\n<< /Type /XObject /Subtype /Image /Width ${imgWidthPx} /Height ${imgHeightPx} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpegBytes.length} >>\nstream\n`
  );
  pushBytes(jpegBytes);
  pushStr('\nendstream\nendobj\n');

  // 5: Content stream
  const contentStream = `q\n${drawW} 0 0 ${drawH} ${drawX} ${drawY} cm\n/Im0 Do\nQ\n`;
  const contentBytes = enc.encode(contentStream);
  offsets.push(length);
  pushStr(`5 0 obj\n<< /Length ${contentBytes.length} >>\nstream\n`);
  pushBytes(contentBytes);
  pushStr('endstream\nendobj\n');

  // XRef table
  const xrefOffset = length;
  pushStr(`xref\n0 ${offsets.length + 1}\n0000000000 65535 f \n`);
  for (const off of offsets) {
    pushStr(`${String(off).padStart(10, '0')} 00000 n \n`);
  }
  pushStr(`trailer\n<< /Size ${offsets.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`);

  const merged = new Uint8Array(length);
  let pos = 0;
  for (const c of chunks) {
    merged.set(c, pos);
    pos += c.length;
  }
  return new Blob([merged], { type: 'application/pdf' });
}

export function downloadReceiptPdf(data: SaqoReceiptData): void {
  const canvas = renderReceiptCanvas(data);
  const jpegDataUrl = canvas.toDataURL('image/jpeg', 0.96);
  const base64 = jpegDataUrl.split(',')[1] || '';
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  const pdfBlob = buildSingleImagePdfBlob(bytes, canvas.width, canvas.height);
  const url = URL.createObjectURL(pdfBlob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `saqo-receipt-${data.reference}.pdf`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function printReceipt(data: SaqoReceiptData): void {
  const canvas = renderReceiptCanvas(data);
  const imgUrl = canvas.toDataURL('image/png');
  const win = window.open('', '_blank', 'width=760,height=920');
  if (!win) {
    window.print();
    return;
  }
  const safeRef = String(data.reference || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
  win.document.write(`
    <!doctype html>
    <html>
      <head>
        <title>SAQO Receipt - ${safeRef}</title>
        <style>
          body { margin: 0; padding: 24px; background: #fff; display: flex; justify-content: center; font-family: sans-serif; }
          img { max-width: 100%; height: auto; }
          @media print { body { padding: 0; } }
        </style>
      </head>
      <body>
        <img src="${imgUrl}" onload="window.focus(); window.print();" />
      </body>
    </html>
  `);
  win.document.close();
}
