import { ArrowLeft } from "lucide-react"
import { Link, useNavigate, useParams } from "react-router"
import { toast } from "sonner"
import { Option, Schema } from "effect"
import { ProfileId, type Profile } from "@integragents/contracts"

import { LoadingRows, Page, QueryError, ReloadButton } from "@/components/page"
import { NewProfileDialog } from "@/components/profiles/new-profile-dialog"
import { ProfileApps } from "@/components/profiles/profile-apps"
import { ProfileSettings } from "@/components/profiles/profile-settings"
import { ProfileTools } from "@/components/profiles/profile-tools"
import { RevokeProfileButton } from "@/components/profiles/revoke-profile-button"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { EditableTitle } from "@/components/ui/editable-title"
import { RowLink, rowNavigates } from "@/components/ui/row-link"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { pluralise, when } from "@/lib/format"
import * as gateway from "@/lib/gateway"
import { keys, refetchAll, useInvalidate, useMutation, useProfiles } from "@/lib/queries"

export function ProfilesRoute() {
  const profiles = useProfiles()
  const rows = [...(profiles.data ?? [])].sort((left, right) =>
    Number(left.profile.revokedAt !== null) - Number(right.profile.revokedAt !== null))
  return <Page
    title="Profiles"
    description="What your AI apps may do. Apps you trust the same way share a profile, each with its own key."
    actions={<><NewProfileDialog /><ReloadButton onClick={() => refetchAll(profiles)} /></>}
  >
    <QueryError error={profiles.error} />
    {profiles.isPending ? <LoadingRows /> : <Card><CardContent className="p-0">
      <Table>
        <TableHeader><TableRow><TableHead>Profile</TableHead><TableHead>Tools</TableHead><TableHead>Apps</TableHead><TableHead>Created</TableHead></TableRow></TableHeader>
        <TableBody>
          {rows.length === 0
            ? <TableRow><TableCell colSpan={4} className="text-muted-foreground py-10 text-center">No profiles yet.</TableCell></TableRow>
            : rows.map(({ profile, tools, approvalTools, keys: keyCount, applications }) => <TableRow key={profile.id} className={rowNavigates}>
              <TableCell>
                <RowLink to={`/profiles/${profile.id}`}>{profile.name}</RowLink>
                {profile.revokedAt === null ? null : <Badge variant="outline" className="ml-2">revoked</Badge>}
              </TableCell>
              <TableCell className="text-sm">
                {tools === 0 ? <span className="text-muted-foreground">None on</span> : <>{pluralise(tools, "tool")}<span className="text-muted-foreground"> · {approvalTools} ask</span></>}
              </TableCell>
              <TableCell className="text-sm">{keyCount + applications === 0 ? <span className="text-muted-foreground">None yet</span> : pluralise(keyCount + applications, "app")}</TableCell>
              <TableCell className="text-muted-foreground text-sm">{when(profile.createdAt)}</TableCell>
            </TableRow>)}
        </TableBody>
      </Table>
    </CardContent></Card>}
  </Page>
}

const decodeProfileId = Schema.decodeUnknownOption(ProfileId)

export function ProfileDetailRoute() {
  const id = Option.getOrUndefined(decodeProfileId(useParams()["profileId"]))
  const profiles = useProfiles()
  const profile = profiles.data?.find((entry) => entry.profile.id === id)?.profile
  return <Page
    title={profile === undefined ? "Profile" : <ProfileTitle profile={profile} />}
    actions={profile === undefined ? undefined : <ProfileActions profile={profile} />}
  >
    <Button variant="ghost" size="sm" className="w-fit" render={<Link to="/profiles" />}><ArrowLeft className="size-3" />All profiles</Button>
    <QueryError error={profiles.error} />
    {profile === undefined
      ? profiles.isPending ? <LoadingRows /> : <p className="text-muted-foreground text-sm">This profile does not exist.</p>
      : <Tabs defaultValue="tools">
        <TabsList>
          <TabsTrigger value="tools">Tools</TabsTrigger>
          <TabsTrigger value="apps">Apps &amp; keys</TabsTrigger>
          <TabsTrigger value="settings">Settings</TabsTrigger>
        </TabsList>
        <TabsContent value="tools"><ProfileTools profile={profile} /></TabsContent>
        <TabsContent value="apps"><ProfileApps profile={profile} /></TabsContent>
        <TabsContent value="settings"><ProfileSettings profile={profile} /></TabsContent>
      </Tabs>}
  </Page>
}

function ProfileTitle({ profile }: { readonly profile: Profile }) {
  const invalidate = useInvalidate()
  const rename = useMutation({
    mutationFn: (name: string) => gateway.renameProfile(profile.id, name),
    onSuccess: (renamed) => { invalidate(keys.profiles); toast.success(`Now called ${renamed.name}`) },
    onError: (error: Error) => toast.error("Could not rename the profile", { description: error.message })
  })
  const revoked = profile.revokedAt !== null
  return <>
    <EditableTitle value={profile.name} onSave={(name) => rename.mutate(name)} saving={rename.isPending} disabled={revoked} />
    {revoked ? <Badge variant="outline">revoked</Badge> : null}
  </>
}

function ProfileActions({ profile }: { readonly profile: Profile }) {
  const navigate = useNavigate()
  return profile.revokedAt === null ? <RevokeProfileButton profile={profile} onRevoked={() => void navigate("/profiles")} /> : null
}
