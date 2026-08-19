export interface Env {
  DB: D1Database;
  COVERS: R2Bucket;
  JWT_SECRET: string;
  ESP32_API_KEY: string;
  WHAKOOM_USER: string;
  WHAKOOM_PASS: string;
  /**
   * Opcional. Sin ella Google Books aplica la cuota anónima por IP, que en los
   * Workers (IP compartida) está agotada casi siempre y responde 429.
   *   wrangler secret put GOOGLE_BOOKS_KEY
   */
  GOOGLE_BOOKS_KEY?: string;
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
