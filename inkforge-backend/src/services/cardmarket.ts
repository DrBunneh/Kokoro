import * as XLSX from "xlsx";
import { parseEuroDecimal } from "../lib/utils";

// ─── Raw row types (as they come off the spreadsheet) ────────────────────────

export interface RawArticlesRow {
  "Shipment nr."?: number | string;
  "Date of purchase"?: string;
  "Article"?: string;
  "Product ID"?: number | string;
  "Localized Product Name"?: string;
  "Expansion"?: string;
  "Category"?: string;
  "Amount"?: number | string;
  "Article Value"?: number | string;
  "Total"?: number | string;
  "Currency"?: string;
  "Comments"?: string;
}

export interface RawOrdersRow {
  "OrderID"?: number | string;
  "Username"?: string;
  "Name"?: string;
  "Street"?: string;
  "City"?: string;
  "Country"?: string;
  "Is Professional"?: string;
  "VAT Number"?: string;
  "Date of Purchase"?: number | string;
  "Article Count"?: number | string;
  "Merchandise Value"?: number | string;
  "Shipment Costs"?: number | string;
  "Trustee service fee"?: number | string;
  "Total Value"?: number | string;
  "Currency"?: string;
  "Description"?: string;
  "Product ID"?: number | string;
  "Localized Product Name"?: string;
}

// ─── Parsed, normalised types ─────────────────────────────────────────────────

export interface ParsedArticle {
  shipmentNr: string;
  dateOfPurchase: string;       // ISO 8601
  articleName: string;
  productId: string;
  expansion: string;
  category: string;
  amount: number;
  articleValuePence: number;    // per-unit value in pence
  totalPence: number;           // amount × articleValue in pence
  currency: string;
  comments: string;
}

export interface ParsedOrder {
  orderId: string;
  username: string;
  country: string;
  isProfessional: boolean;
  vatNumber: string | null;
  merchandiseValuePence: number;
  shipmentCostsPence: number;
  trusteeFeesPence: number;
  totalValuePence: number;
  currency: string;
  // Items within this order (from continuation rows)
  items: Array<{
    description: string;
    productId: string;
    localizedName: string;
  }>;
}

// ─── Excel date serial → ISO string ──────────────────────────────────────────

function excelDateToISO(serial: number | string): string {
  if (typeof serial === "string") {
    // Already a date string like "05/11/2025 0:11"
    const parts = serial.split(" ");
    const dateParts = parts[0]?.split("/");
    if (dateParts && dateParts.length === 3) {
      const [dd, mm, yyyy] = dateParts;
      const time = parts[1] ?? "00:00";
      return `${yyyy}-${mm?.padStart(2, "0")}-${dd?.padStart(2, "0")}T${time}:00.000Z`;
    }
    return new Date(serial).toISOString();
  }
  // Excel date serial: days since 1900-01-00 (with Lotus 1-2-3 leap year bug offset)
  const date = new Date((serial - 25569) * 86400 * 1000);
  return date.toISOString();
}

// ─── File parsing ─────────────────────────────────────────────────────────────

export function parseArticlesFile(buffer: ArrayBuffer): ParsedArticle[] {
  const workbook = XLSX.read(buffer, { type: "buffer" });
  const sheet = workbook.Sheets[workbook.SheetNames[0] ?? ""];
  if (!sheet) throw new Error("Articles file has no sheets");

  const rows = XLSX.utils.sheet_to_json<RawArticlesRow>(sheet, { defval: "" });
  const articles: ParsedArticle[] = [];

  for (const row of rows) {
    const shipmentNr = String(row["Shipment nr."] ?? "").trim();
    if (!shipmentNr) continue; // skip blank rows

    const articleName = String(row["Article"] ?? row["Localized Product Name"] ?? "").trim();
    if (!articleName) continue;

    const amount = Number(row["Amount"] ?? 1);
    const articleValuePence = parseEuroDecimal(row["Article Value"] ?? 0);
    const totalPence = parseEuroDecimal(row["Total"] ?? 0) || amount * articleValuePence;

    articles.push({
      shipmentNr,
      dateOfPurchase: excelDateToISO(row["Date of purchase"] ?? ""),
      articleName,
      productId: String(row["Product ID"] ?? "").trim(),
      expansion: String(row["Expansion"] ?? "").trim(),
      category: String(row["Category"] ?? "").trim(),
      amount,
      articleValuePence,
      totalPence,
      currency: String(row["Currency"] ?? "GBP").trim(),
      comments: String(row["Comments"] ?? "").trim(),
    });
  }

  return articles;
}

export function parseOrdersFile(buffer: ArrayBuffer): ParsedOrder[] {
  const workbook = XLSX.read(buffer, { type: "buffer" });
  const sheet = workbook.Sheets[workbook.SheetNames[0] ?? ""];
  if (!sheet) throw new Error("Orders file has no sheets");

  const rows = XLSX.utils.sheet_to_json<RawOrdersRow>(sheet, { defval: "" });
  const orders: ParsedOrder[] = [];
  let currentOrder: ParsedOrder | null = null;

  for (const row of rows) {
    const rawOrderId = String(row["OrderID"] ?? "").trim();

    if (rawOrderId && rawOrderId !== "0") {
      // New order row
      currentOrder = {
        orderId: rawOrderId,
        username: String(row["Username"] ?? "").trim(),
        country: String(row["Country"] ?? "").trim(),
        isProfessional: String(row["Is Professional"] ?? "").trim() === "X",
        vatNumber: String(row["VAT Number"] ?? "").trim() || null,
        merchandiseValuePence: parseEuroDecimal(row["Merchandise Value"] ?? 0),
        shipmentCostsPence: parseEuroDecimal(row["Shipment Costs"] ?? 0),
        trusteeFeesPence: parseEuroDecimal(row["Trustee service fee"] ?? 0),
        totalValuePence: parseEuroDecimal(row["Total Value"] ?? 0),
        currency: String(row["Currency"] ?? "GBP").trim(),
        items: [],
      };

      // First item is on the same row as the order header
      const description = String(row["Description"] ?? "").trim();
      const productId = String(row["Product ID"] ?? "").trim();
      const localizedName = String(row["Localized Product Name"] ?? "").trim();
      if (description || productId) {
        currentOrder.items.push({ description, productId, localizedName });
      }

      orders.push(currentOrder);
    } else if (currentOrder) {
      // Continuation row — additional items in the same order
      const description = String(row["Description"] ?? "").trim();
      const productId = String(row["Product ID"] ?? "").trim();
      const localizedName = String(row["Localized Product Name"] ?? "").trim();
      if (description || productId) {
        currentOrder.items.push({ description, productId, localizedName });
      }
    }
  }

  return orders;
}

// ─── Hash utility (SHA-256 of file bytes) ────────────────────────────────────

export async function hashFile(buffer: ArrayBuffer): Promise<string> {
  const hashBuffer = await crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ─── Import summary (used for preview step) ──────────────────────────────────

export interface ImportPreview {
  ordersCount: number;
  lineItemsCount: number;
  merchandiseTotalPence: number;
  shippingTotalPence: number;
  trusteeFeesTotalPence: number;
  grandTotalPence: number;
  articles: ParsedArticle[];
  orders: ParsedOrder[];
}

export function buildImportPreview(
  articles: ParsedArticle[],
  orders: ParsedOrder[]
): ImportPreview {
  const ordersCount = orders.length;
  const lineItemsCount = articles.length;
  const merchandiseTotalPence = articles.reduce((s, a) => s + a.totalPence, 0);
  const shippingTotalPence = orders.reduce((s, o) => s + o.shipmentCostsPence, 0);
  const trusteeFeesTotalPence = orders.reduce((s, o) => s + o.trusteeFeesPence, 0);

  return {
    ordersCount,
    lineItemsCount,
    merchandiseTotalPence,
    shippingTotalPence,
    trusteeFeesTotalPence,
    grandTotalPence: merchandiseTotalPence + shippingTotalPence + trusteeFeesTotalPence,
    articles,
    orders,
  };
}
