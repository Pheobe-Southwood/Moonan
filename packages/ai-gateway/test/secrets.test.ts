import { describe, expect, it } from "vitest";
import {
	isSensitiveName,
	maskSensitiveMap,
	REDACTED,
	restoreSensitiveMap,
} from "../src/secrets.js";

describe("sensitive names", () => {
	it("recognizes credential-like header and env names case-insensitively", () => {
		for (const name of [
			"authorization",
			"Authorization",
			"proxy-authorization",
			"x-api-key",
			"api_key",
			"x-auth-token",
			"x-auth",
			"authentication",
			"cookie",
			"set-cookie",
			"x-signature",
			"AWS_SECRET_ACCESS_KEY",
			"OPENAI_API_KEY",
			"GITHUB_TOKEN",
			"DB_PASSWORD",
			"GOOGLE_APPLICATION_CREDENTIALS",
			"AWS_ACCESS_KEY_ID",
			"x-functions-key",
			"Ocp-Apim-Subscription-Key",
			"client_private_key",
		]) {
			expect(isSensitiveName(name), name).toBe(true);
		}
		for (const name of ["x-project-id", "AWS_REGION", "anthropic-version", "accept", "user-agent"]) {
			expect(isSensitiveName(name), name).toBe(false);
		}
	});
});

describe("maskSensitiveMap", () => {
	it("masks only sensitive string values and keeps null delete markers", () => {
		const masked = maskSensitiveMap({
			Authorization: "Bearer sk-secret",
			"x-api-key": "sk-key",
			"x-project-id": "proj-1",
			"x-removed": null,
			"proxy-authorization": null,
		});
		expect(masked).toEqual({
			Authorization: REDACTED,
			"x-api-key": REDACTED,
			"x-project-id": "proj-1",
			"x-removed": null,
			"proxy-authorization": null,
		});
	});

	it("keeps undefined as undefined", () => {
		expect(maskSensitiveMap(undefined)).toBeUndefined();
	});

	it("does not mutate the input map", () => {
		const input = { Authorization: "Bearer sk-secret", "x-project-id": "proj-1" };
		maskSensitiveMap(input);
		expect(input).toEqual({ Authorization: "Bearer sk-secret", "x-project-id": "proj-1" });
	});
});

describe("restoreSensitiveMap", () => {
	const stored: Record<string, string | null> = {
		Authorization: "Bearer sk-secret",
		"x-project-id": "proj-1",
	};

	it("takes the stored value back for a redacted entry", () => {
		expect(restoreSensitiveMap({ Authorization: REDACTED, "x-project-id": "proj-2" }, stored)).toEqual({
			Authorization: "Bearer sk-secret",
			"x-project-id": "proj-2",
		});
	});

	it("lets a typed value replace the stored one", () => {
		expect(restoreSensitiveMap({ Authorization: "Bearer new" }, stored)).toEqual({
			Authorization: "Bearer new",
		});
	});

	it("drops a redacted entry with nothing stored to restore", () => {
		expect(restoreSensitiveMap({ "x-api-key": REDACTED }, stored)).toEqual({});
	});

	it("preserves null delete markers and empty maps", () => {
		expect(restoreSensitiveMap({ "x-removed": null }, stored)).toEqual({ "x-removed": null });
		expect(restoreSensitiveMap({}, stored)).toEqual({});
	});
});
