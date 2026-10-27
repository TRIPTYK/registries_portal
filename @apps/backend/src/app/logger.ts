import { pino } from "pino";
import type { AppConfiguration } from "../configuration.js";

export function logger(configuration: Pick<AppConfiguration, "PRODUCTION_ENV">) {
  // En production, JSON brut sur stdout (lu par le driver de logs Docker) :
  // `transport: { target: "pino" }` plante au démarrage (`destination.write is not a function`).
  // @lat: [[apps/backend-bootstrap#Configuration de production#Logger]]
  if (configuration.PRODUCTION_ENV) {
    return pino();
  }

  return pino({
    transport: {
      target: "pino-pretty",
      options: {
        translateTime: "HH:MM:ss Z",
        ignore: "pid,hostname",
      },
    },
  });
}
