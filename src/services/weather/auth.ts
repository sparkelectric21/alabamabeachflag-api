import type { Env } from "../../types";
import { importPKCS8, SignJWT } from "jose";

export async function createWeatherKitToken(env: Env): Promise<string> {

    if (!env.WEATHERKIT_TEAM_ID) {
        throw new Error("Missing WEATHERKIT_TEAM_ID");
    }

    if (!env.WEATHERKIT_KEY_ID) {
        throw new Error("Missing WEATHERKIT_KEY_ID");
    }

    if (!env.WEATHERKIT_PRIVATE_KEY) {
        throw new Error("Missing WEATHERKIT_PRIVATE_KEY");
    }

    if (!env.WEATHERKIT_SERVICE_ID) {
        throw new Error("Missing WEATHERKIT_SERVICE_ID");
    }

    const algorithm = "ES256";

    const privateKeyText = env.WEATHERKIT_PRIVATE_KEY.replace(/\\n/g, "\n");

    const privateKey = await importPKCS8(
        privateKeyText,
        algorithm
    );

    const now = Math.floor(Date.now() / 1000);

    const token = await new SignJWT({})
        .setProtectedHeader({
            alg: algorithm,
            kid: env.WEATHERKIT_KEY_ID,
            id: `${env.WEATHERKIT_TEAM_ID}.${env.WEATHERKIT_SERVICE_ID}`
        })
        .setIssuer(env.WEATHERKIT_TEAM_ID)
        .setSubject(env.WEATHERKIT_SERVICE_ID)
        .setIssuedAt(now)
        .setExpirationTime(now + 60 * 60)
        .sign(privateKey);

    return token;
}