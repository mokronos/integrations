import { BookOpen, ChevronRight, Radio, Search, Wrench } from "lucide-react"
import { useMemo, useState } from "react"
import type { ReactNode } from "react"
import type { ConnectionSkill, EventType, IntegrationOverview, Tool } from "@integragents/contracts"

import { SchemaView } from "@/components/schema-view"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Item, ItemContent, ItemDescription, ItemMedia, ItemTitle } from "@/components/ui/item"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { useIntegrationSkills } from "@/lib/queries"
import { cn } from "@/lib/utils"

type Capability = "tools" | "skills" | "events"

const isConnected = (integration: IntegrationOverview): boolean =>
  integration.connections.some((connection) => connection.status === "connected")

/** One row that opens to show what it is made of. */
function Expandable({
  title,
  badges,
  description,
  children
}: {
  readonly title: string
  readonly badges: ReactNode
  readonly description: string
  readonly children: ReactNode
}) {
  const [open, setOpen] = useState(false)
  return (
    <div className="min-w-0 rounded-lg border">
      <Item
        render={<button type="button" aria-expanded={open} onClick={() => setOpen(!open)} />}
        className="cursor-pointer select-none hover:bg-muted"
      >
        <ItemMedia>
          <ChevronRight aria-hidden className={cn("size-4 transition-transform", open && "rotate-90")} />
        </ItemMedia>
        <ItemContent>
          <ItemTitle>
            <span className="min-w-0 truncate">{title}</span>
            {badges}
          </ItemTitle>
          {description.length === 0 ? null : <ItemDescription className="truncate">{description}</ItemDescription>}
        </ItemContent>
      </Item>
      {open ? (
        <div className="space-y-3 border-t p-3">
          {description.length === 0 ? null : <p className="text-muted-foreground text-sm">{description}</p>}
          {children}
        </div>
      ) : null}
    </div>
  )
}

function ToolCard({ tool }: { readonly tool: Tool }) {
  return (
    <Expandable
      title={tool.name}
      description={tool.description}
      badges={
        <Badge variant="outline" className="shrink-0">
          {tool.connection}
        </Badge>
      }
    >
      <div className="grid min-w-0 gap-2 xl:grid-cols-2">
        <SchemaView schema={tool.inputSchema} definitions={tool.schemaDefinitions} label="input" />
        <SchemaView schema={tool.outputSchema} definitions={tool.schemaDefinitions} label="output" />
      </div>
    </Expandable>
  )
}

function SkillCard({ entry }: { readonly entry: ConnectionSkill }) {
  const { skill } = entry
  return (
    <Expandable
      title={skill.frontmatter.name}
      description={skill.frontmatter.description}
      badges={
        <Badge variant="outline" className="shrink-0">
          {entry.connection}
        </Badge>
      }
    >
      {skill.resources === "dynamic" ? (
        <p className="text-muted-foreground text-sm">
          <span className="break-all font-mono text-xs">{skill.uri}</span>: its other files are generated on request.
        </p>
      ) : (
        <ul className="space-y-1 text-sm">
          {skill.resources.map((file) => (
            <li key={file.uri} className="flex min-w-0 items-center justify-between gap-2">
              <span className="min-w-0 truncate font-mono text-xs">{file.uri}</span>
              <span className="text-muted-foreground shrink-0 text-xs">{file.size} bytes</span>
            </li>
          ))}
        </ul>
      )}
    </Expandable>
  )
}

function EventTypeCard({ eventType }: { readonly eventType: EventType }) {
  return (
    <Expandable
      title={eventType.name}
      description={eventType.description}
      badges={
        <>
          <Badge variant="outline" className="shrink-0">
            {eventType.connection}
          </Badge>
          {eventType.delivery.map((mode) => (
            <Badge key={mode} variant="secondary" className="shrink-0">
              {mode}
            </Badge>
          ))}
        </>
      }
    >
      <div className="grid min-w-0 gap-2 xl:grid-cols-2">
        <SchemaView schema={eventType.inputSchema} label="subscription arguments" />
        <SchemaView schema={eventType.payloadSchema} label="payload" />
      </div>
    </Expandable>
  )
}

const matches = (needle: string, ...fields: ReadonlyArray<string>): boolean =>
  needle.length === 0 || fields.join(" ").toLowerCase().includes(needle)

function Listing<A>({
  items,
  render,
  empty
}: {
  readonly items: ReadonlyArray<A>
  readonly render: (item: A) => ReactNode
  readonly empty: string
}) {
  return items.length === 0 ? <p className="text-muted-foreground text-sm">{empty}</p> : <>{items.map(render)}</>
}

/**
 * What an integration offers an agent, the way a plugin lists its
 * capabilities: the tools it can call, the skills its server publishes, and
 * the events (MCP Events) it can be told about.
 */
export function IntegrationCapabilities({ integration }: { readonly integration: IntegrationOverview }) {
  const [filter, setFilter] = useState("")
  const [tab, setTab] = useState<Capability>("tools")
  const mcp = integration.kind === "mcp"
  const skills = useIntegrationSkills(integration.slug, mcp && integration.connections.length > 0)
  const needle = filter.trim().toLowerCase()
  const connected = isConnected(integration)

  const tools = useMemo(
    () => integration.tools.filter((tool) => matches(needle, tool.name, tool.address, tool.description)),
    [needle, integration.tools]
  )
  const eventTypes = useMemo(
    () => integration.eventTypes.filter((eventType) => matches(needle, eventType.name, eventType.description)),
    [needle, integration.eventTypes]
  )
  const skillEntries = useMemo(
    () =>
      (skills.data?.skills ?? []).filter((entry) =>
        matches(needle, entry.skill.frontmatter.name, entry.skill.frontmatter.description)
      ),
    [needle, skills.data]
  )
  const nothingYet = connected ? undefined : "Connect it to see what it exposes."

  return (
    <Card>
      <Tabs value={tab} onValueChange={(value: Capability) => setTab(value)}>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <TabsList>
              <TabsTrigger value="tools">
                <Wrench />
                Tools <span className="text-muted-foreground tabular-nums">{integration.tools.length}</span>
              </TabsTrigger>
              <TabsTrigger value="skills" disabled={!mcp}>
                <BookOpen />
                Skills{" "}
                <span className="text-muted-foreground tabular-nums">
                  {skills.data === undefined ? "…" : skills.data.skills.length}
                </span>
              </TabsTrigger>
              <TabsTrigger value="events" disabled={!mcp}>
                <Radio />
                Events <span className="text-muted-foreground tabular-nums">{integration.eventTypes.length}</span>
              </TabsTrigger>
            </TabsList>
            <div className="relative w-full sm:w-64">
              <Search className="text-muted-foreground absolute left-2 top-1/2 size-3.5 -translate-y-1/2" />
              <Input
                className="pl-7"
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
                placeholder={`Filter ${tab}`}
              />
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <TabsContent value="tools" className="space-y-2">
            {integration.toolError === undefined ? null : (
              <Alert variant="destructive">
                <AlertTitle>Could not refresh tools</AlertTitle>
                <AlertDescription>
                  <p>
                    <span className="font-medium">Stopped at:</span> Reading tools from the live endpoint
                  </p>
                  <p>{integration.toolError}</p>
                </AlertDescription>
              </Alert>
            )}
            <Listing
              items={tools}
              render={(tool) => <ToolCard key={tool.address} tool={tool} />}
              empty={
                integration.tools.length > 0
                  ? "Nothing matches that filter."
                  : (nothingYet ?? "This connection exposes no callable tools.")
              }
            />
          </TabsContent>
          <TabsContent value="skills" className="space-y-2">
            {skills.data?.error === undefined ? null : (
              <Alert variant="destructive">
                <AlertTitle>Could not read every server's skills</AlertTitle>
                <AlertDescription>{skills.data.error}</AlertDescription>
              </Alert>
            )}
            {skills.error === null ? null : (
              <Alert variant="destructive">
                <AlertTitle>Could not read skills</AlertTitle>
                <AlertDescription>{skills.error.message}</AlertDescription>
              </Alert>
            )}
            {skills.isPending && skills.fetchStatus !== "idle" ? (
              <p className="text-muted-foreground text-sm">Asking the server for its skills…</p>
            ) : (
              <Listing
                items={skillEntries}
                render={(entry) => <SkillCard key={`${entry.connection}:${entry.skill.uri}`} entry={entry} />}
                empty={
                  (skills.data?.skills.length ?? 0) > 0
                    ? "Nothing matches that filter."
                    : (nothingYet ?? "Its server publishes no skills.")
                }
              />
            )}
          </TabsContent>
          <TabsContent value="events" className="space-y-2">
            <Listing
              items={eventTypes}
              render={(eventType) => (
                <EventTypeCard key={`${eventType.connection}:${eventType.name}`} eventType={eventType} />
              )}
              empty={
                integration.eventTypes.length > 0
                  ? "Nothing matches that filter."
                  : (nothingYet ?? "Its server offers no events to subscribe to.")
              }
            />
          </TabsContent>
        </CardContent>
      </Tabs>
    </Card>
  )
}
