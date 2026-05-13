// D02 Stage 4 — Normalize + Validate Transform (PLAN §2.1)
// phone_e164, state, date_of_birth, custom_data validation.

import { Transform } from "node:stream";
import type { TransformCallback } from "node:stream";
import { parsePhoneNumberFromString } from "libphonenumber-js/min";
import type { CountryCode } from "libphonenumber-js/min";
import { parse as dateFnsParse, isValid as isDateValid } from "date-fns";
import type {
  MappedRow,
  NormalizedLead,
  NormalizedRow,
  RowError,
} from "./types.js";
import type { ErrorCode } from "./error-codes.js";

const US_STATES = new Set([
  "AL","AK","AZ","AR","CA","CO","CT","DE","FL","GA","HI","ID","IL","IN","IA",
  "KS","KY","LA","ME","MD","MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ",
  "NM","NY","NC","ND","OH","OK","OR","PA","RI","SC","SD","TN","TX","UT","VT",
  "VA","WA","WV","WI","WY","DC","PR","VI","GU","AS","MP",
]);

export interface NormalizeValidateOptions {
  defaultCountry?: string;
  defaultStatus?: string;
  strictPhone?: boolean;
  lookupStateFromZip?: boolean;
}

export class NormalizeValidateTransform extends Transform {
  private _opts: NormalizeValidateOptions;

  constructor(opts: NormalizeValidateOptions = {}) {
    super({ objectMode: true, highWaterMark: 16 });
    this._opts = opts;
  }

  override _transform(row: MappedRow, _enc: string, cb: TransformCallback): void {
    const errors: RowError[] = [];
    const { mapped, rawRecord, info } = row;
    const defaultCountry = (this._opts.defaultCountry ?? "US") as CountryCode;
    const defaultStatus = this._opts.defaultStatus ?? "NEW";

    const makeError = (code: ErrorCode, message: string): RowError => ({
      code, message, sourceLine: info.lines, sourceRecord: info.records, rawRecord,
    });

    // ── phone_e164 (required) ──────────────────────────────────────────────
    const rawPhone = mapped["phone_e164"] ?? "";
    if (!rawPhone.trim()) {
      errors.push(makeError("MISSING_REQUIRED_FIELD", "phone_e164 is required"));
      const out: NormalizedRow = { lead: null, rawRecord, info, errors };
      this.push(out);
      return cb();
    }

    let phoneE164: string;
    try {
      const parsed = parsePhoneNumberFromString(rawPhone, defaultCountry);
      if (!parsed || !parsed.isValid()) {
        errors.push(makeError("INVALID_PHONE", `E.164 parse failed: "${rawPhone}"`));
        const out: NormalizedRow = { lead: null, rawRecord, info, errors };
        this.push(out);
        return cb();
      }
      phoneE164 = parsed.number;
    } catch {
      errors.push(makeError("INVALID_PHONE", `E.164 parse failed: "${rawPhone}"`));
      const out: NormalizedRow = { lead: null, rawRecord, info, errors };
      this.push(out);
      return cb();
    }

    // ── phone_alt / phone_alt2 (optional, soft validation) ───────────────
    let phoneAlt: string | undefined;
    let phoneAlt2: string | undefined;
    const rawAlt = mapped["phone_alt"];
    if (rawAlt?.trim()) {
      try {
        const p = parsePhoneNumberFromString(rawAlt, defaultCountry);
        phoneAlt = p?.isValid() ? p.number : rawAlt;
      } catch { phoneAlt = rawAlt; }
    }
    const rawAlt2 = mapped["phone_alt2"];
    if (rawAlt2?.trim()) {
      try {
        const p = parsePhoneNumberFromString(rawAlt2, defaultCountry);
        phoneAlt2 = p?.isValid() ? p.number : rawAlt2;
      } catch { phoneAlt2 = rawAlt2; }
    }

    // ── state validation ──────────────────────────────────────────────────
    let state: string | undefined = mapped["state"]?.toUpperCase().trim() || undefined;
    if (state && !US_STATES.has(state)) {
      // Could try ZIP lookup here if opts.lookupStateFromZip — deferred
      errors.push(makeError("INVALID_STATE", `"${state}" is not a valid US state code`));
      state = undefined;
    }

    // ── date_of_birth (optional) ──────────────────────────────────────────
    let dateOfBirth: string | undefined;
    const rawDob = mapped["date_of_birth"];
    if (rawDob?.trim()) {
      // Accept ISO date (YYYY-MM-DD) or try common formats
      const isoMatch = /^\d{4}-\d{2}-\d{2}$/.test(rawDob.trim());
      if (isoMatch) {
        dateOfBirth = rawDob.trim();
      } else {
        const formats = ["MM/dd/yyyy", "M/d/yyyy", "dd-MM-yyyy", "yyyy/MM/dd"];
        let parsed: Date | null = null;
        for (const fmt of formats) {
          const d = dateFnsParse(rawDob.trim(), fmt, new Date(0));
          if (isDateValid(d)) { parsed = d; break; }
        }
        if (parsed) {
          dateOfBirth = parsed.toISOString().split("T")[0]!;
        } else {
          errors.push(makeError("INVALID_DATE", `Cannot parse date_of_birth: "${rawDob}"`));
        }
      }
    }

    // ── gender ────────────────────────────────────────────────────────────
    const rawGender = mapped["gender"]?.toUpperCase().trim();
    const gender: "M" | "F" | "U" =
      rawGender === "M" || rawGender === "MALE" ? "M" :
      rawGender === "F" || rawGender === "FEMALE" ? "F" :
      "U";

    // ── rank ──────────────────────────────────────────────────────────────
    const rawRank = mapped["rank"];
    const rank = rawRank ? parseInt(rawRank, 10) : 0;

    // ── custom_data ───────────────────────────────────────────────────────
    const customData: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(mapped)) {
      if (k.startsWith("custom.")) {
        customData[k.slice(7)] = v;
      }
    }

    const lead: NormalizedLead = {
      phoneE164,
      phoneAlt,
      phoneAlt2,
      firstName: mapped["first_name"]?.trim() || undefined,
      lastName: mapped["last_name"]?.trim() || undefined,
      middleInitial: mapped["middle_initial"]?.trim().slice(0, 4) || undefined,
      title: mapped["title"]?.trim().slice(0, 8) || undefined,
      address1: mapped["address1"]?.trim().slice(0, 128) || undefined,
      address2: mapped["address2"]?.trim().slice(0, 128) || undefined,
      city: mapped["city"]?.trim().slice(0, 64) || undefined,
      state,
      postalCode: mapped["postal_code"]?.trim().slice(0, 16) || undefined,
      countryCode: (mapped["country_code"]?.trim().toUpperCase().slice(0, 2) || this._opts.defaultCountry || "US"),
      email: mapped["email"]?.trim().toLowerCase().slice(0, 128) || undefined,
      dateOfBirth,
      gender,
      comments: mapped["comments"]?.trim() || undefined,
      rank: isNaN(rank) ? 0 : rank,
      vendorLeadCode: mapped["vendor_lead_code"]?.trim().slice(0, 64) || undefined,
      sourceId: mapped["source_id"]?.trim().slice(0, 64) || undefined,
      status: defaultStatus,
      tzBlocked: false,
      dncBlocked: false,
      customData,
    };

    const out: NormalizedRow = { lead: errors.length === 0 ? lead : null, rawRecord, info, errors };
    if (errors.length === 0) {
      out.lead = lead;
    }
    this.push(out);
    cb();
  }

  override _flush(cb: TransformCallback): void { cb(); }
}
