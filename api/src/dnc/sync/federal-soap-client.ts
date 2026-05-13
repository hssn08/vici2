// D05 — Federal DNC SOAP client (PLAN §3.1).
// Hand-rolled XML over fetch (~150 lines) per PLAN decision.
// Endpoint: https://telemarketing.donotcall.gov/DownloadSvc/DownloadSvc.asmx

import {
  LoginResponseSchema,
  CanGetChangeFileResponseSchema,
  GetChangeFileResponseSchema,
  CanGetFullFileResponseSchema,
  GetFullFileResponseSchema,
  type ChangeFileStatus,
} from "./federal-soap-schema.js";

const ENDPOINT =
  "https://telemarketing.donotcall.gov/DownloadSvc/DownloadSvc.asmx";
const NS = "http://telemarketing.donotcall.gov/";

// ── XML helpers ───────────────────────────────────────────────────────────────

function soapEnvelope(action: string, body: string): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"
               xmlns:tns="${NS}">
  <soap:Body>
    <tns:${action}>${body}</tns:${action}>
  </soap:Body>
</soap:Envelope>`;
}

function extractTag(xml: string, tag: string): string | null {
  const re = new RegExp(`<(?:[^:]+:)?${tag}>([^<]*)<`);
  const m = re.exec(xml);
  return m?.[1] ?? null;
}

async function soapPost(action: string, body: string): Promise<string> {
  const envelope = soapEnvelope(action, body);
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "text/xml; charset=utf-8",
      SOAPAction: `"${NS}${action}"`,
    },
    body: envelope,
  });
  if (!res.ok) {
    throw new Error(`SOAP ${action} HTTP ${res.status}`);
  }
  return res.text();
}

// ── Client ────────────────────────────────────────────────────────────────────

export interface FederalSoapConfig {
  san: string;     // Subscription Account Number
  password: string;
  coId: string;    // Company ID
}

export class FederalSoapClient {
  constructor(private cfg: FederalSoapConfig) {}

  async logIn(): Promise<string> {
    const xml = await soapPost(
      "LogIn",
      `<tns:strSAN>${this.cfg.san}</tns:strSAN>
       <tns:strRepPwd>${this.cfg.password}</tns:strRepPwd>
       <tns:strCoID>${this.cfg.coId}</tns:strCoID>`,
    );
    const token = extractTag(xml, "strSessionToken");
    if (!token) throw new Error("LogIn: missing strSessionToken");
    LoginResponseSchema.parse({ strSessionToken: token });
    return token;
  }

  async canGetChangeFile(sessionToken: string): Promise<ChangeFileStatus> {
    const xml = await soapPost(
      "CanGetChangeFile",
      `<tns:strSessionToken>${sessionToken}</tns:strSessionToken>
       <tns:strCoID>${this.cfg.coId}</tns:strCoID>`,
    );
    const status = extractTag(xml, "strStatus");
    if (!status) throw new Error("CanGetChangeFile: missing strStatus");
    return CanGetChangeFileResponseSchema.parse({ strStatus: status }).strStatus;
  }

  async getChangeFile(sessionToken: string): Promise<string> {
    const xml = await soapPost(
      "GetChangeFile",
      `<tns:strSessionToken>${sessionToken}</tns:strSessionToken>
       <tns:strCoID>${this.cfg.coId}</tns:strCoID>
       <tns:strFormat>FlatText</tns:strFormat>
       <tns:strAreaCode>ALL</tns:strAreaCode>`,
    );
    const url = extractTag(xml, "strPresignedUrl");
    if (!url) throw new Error("GetChangeFile: missing strPresignedUrl");
    return GetChangeFileResponseSchema.parse({ strPresignedUrl: url }).strPresignedUrl;
  }

  async canGetFullFile(sessionToken: string): Promise<string> {
    const xml = await soapPost(
      "CanGetFullFile",
      `<tns:strSessionToken>${sessionToken}</tns:strSessionToken>
       <tns:strCoID>${this.cfg.coId}</tns:strCoID>`,
    );
    const status = extractTag(xml, "strStatus");
    if (!status) throw new Error("CanGetFullFile: missing strStatus");
    return CanGetFullFileResponseSchema.parse({ strStatus: status }).strStatus;
  }

  async getFullFile(sessionToken: string): Promise<string> {
    const xml = await soapPost(
      "GetFullFile",
      `<tns:strSessionToken>${sessionToken}</tns:strSessionToken>
       <tns:strCoID>${this.cfg.coId}</tns:strCoID>
       <tns:strFormat>FlatText</tns:strFormat>
       <tns:strAreaCode>ALL</tns:strAreaCode>`,
    );
    const url = extractTag(xml, "strPresignedUrl");
    if (!url) throw new Error("GetFullFile: missing strPresignedUrl");
    return GetFullFileResponseSchema.parse({ strPresignedUrl: url }).strPresignedUrl;
  }

  async logOut(sessionToken: string): Promise<void> {
    await soapPost(
      "LogOut",
      `<tns:strSessionToken>${sessionToken}</tns:strSessionToken>`,
    );
  }
}
