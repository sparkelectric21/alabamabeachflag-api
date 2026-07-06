export function normalizeWeatherCondition(
    description: string | undefined,
): string | undefined {
    if (!description) {
        return undefined;
    }

	const key = description.trim().toLowerCase();

	if (key.includes("freezing rain")) {
		return "Freezing Rain";
	}

	if (key.includes("freezing drizzle")) {
		return "Freezing Drizzle";
	}

	if (key.includes("wintry mix") || key.includes("mixed precipitation")) {
		return "Wintry Mix";
	}

    if (key.includes("tornado")) {
        return "Tornado";
    }

    if (key.includes("waterspout")) {
        return "Waterspout";
    }

    if (key.includes("severe thunderstorm")) {
        return "Severe Storms";
    }

    if (key.includes("thunderstorm")) {
        return "Chance of Storms";
    }

    if (key.includes("heavy rain")) {
        return "Heavy Rain";
    }

    if (key.includes("light rain")) {
        return "Light Rain";
    }

    if (key.includes("showers") || key.includes("drizzle")) {
        return "Chance of Rain";
    }

    if (key.includes("rain")) {
        return "Rain";
    }

    if (key.includes("sprinkles")) {
        return "Light Rain";
    }

    if (key.includes("mostly sunny")) {
        return "Mostly Sunny";
    }

    if (key.includes("partly sunny")) {
        return "Partly Sunny";
    }

    if (key.includes("mostly cloudy")) {
        return "Mostly Cloudy";
    }

    if (key.includes("partly cloudy")) {
        return "Partly Cloudy";
    }

    if (key.includes("overcast") || key === "cloudy") {
        return "Cloudy";
    }

    if (key.includes("clear")) {
        return "Clear";
    }

    if (key === "sunny") {
        return "Sunny";
    }

    if (key.includes("fog") || key.includes("mist") || key.includes("haze")) {
        return "Fog";
    }

    if (key.includes("wind") || key.includes("breezy")) {
        return "Windy";
    }

    if (key.includes("snow")) {
        return "Snow";
    }

    if (key.includes("flurries")) {
        return "Flurries";
    }

    if (key.includes("smoke")) {
        return "Smoke";
    }

    if (key.includes("dust") || key.includes("sand")) {
        return "Blowing Dust";
    }

    return description;
}
