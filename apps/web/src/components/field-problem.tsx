/** What is wrong with one input, under it. */
export function FieldProblem({ problem }: { readonly problem: string | undefined }) {
  return problem === undefined ? null : <p className="text-destructive text-xs">{problem}</p>
}
