import { Config, Option } from "effect"

/**
 * Reads a setting whose blank spelling means "unset". A shell exports `""` for
 * a variable named without a value, and every setting read this way treats
 * that as absent rather than as the empty string. The value is trimmed, so
 * whitespace picked up from a copied-in value does not travel with it.
 */
export const optionalText = (name: string): Config.Config<Option.Option<string>> =>
  Config.option(Config.string(name)).pipe(
    Config.map(Option.flatMap((value) => {
      const trimmed = value.trim()
      return trimmed.length === 0 ? Option.none() : Option.some(trimmed)
    }))
  )
