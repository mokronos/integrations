declare module "integrations:embedded-web" {
  export interface EmbeddedWebAsset {
    readonly path: string
    readonly source: string
  }

  export const embeddedWebAssets: ReadonlyArray<EmbeddedWebAsset>
}
