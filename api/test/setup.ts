// Test bootstrap — populate auth env so jwt/encryption helpers init.

import { randomBytes } from "node:crypto";

process.env.VICI2_JWT_ALG = "EdDSA";
process.env.VICI2_KEK_V1 = randomBytes(32).toString("base64");
process.env.VICI2_KEK_CURRENT_VERSION = "1";
process.env.VICI2_PASSWORD_PEPPER = randomBytes(32).toString("base64");
process.env.HIBP_OFFLINE = "true";
process.env.NODE_ENV = "test";
