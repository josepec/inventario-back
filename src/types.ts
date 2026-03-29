export interface Env {
  DB: D1Database;
  JWT_SECRET: string;
  ESP32_API_KEY: string;
}

export interface JwtPayload {
  sub: number;       // user id
  username: string;
  iat: number;
  exp: number;
}

// Tipo de contexto Hono compartido en toda la app
export type AppContext = {
  Bindings: Env;
  Variables: {
    jwtPayload: JwtPayload;
  };
};
