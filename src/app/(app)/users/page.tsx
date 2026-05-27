"use client";

import { useState } from "react";
import {
  User as UserIcon,
  Shield,
  Plus,
  Trash2,
  Link2,
  Check,
  Copy,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { EmptyState } from "@/components/app/empty-state";
import { PageHeader, PageLoading } from "@/components/app/page-header";
import { useApp } from "@/components/app/app-context";
import { useMe, orgsFromMe } from "@/lib/hooks/use-orgs";
import {
  useUsers,
  useCreateUser,
  useUpdateUser,
  useDeleteUser,
  useSetPasswordLink,
  useAddMembership,
  useRemoveMembership,
  type UserRow,
  type SetPasswordLink,
} from "@/lib/hooks/use-users";

export default function UsersPage() {
  const { user } = useApp();
  const isAdmin = !!user?.isInstanceAdmin;

  if (!isAdmin) {
    return (
      <div className="space-y-6">
        <PageHeader title="Users" />
        <EmptyState>Only instance admins can manage users.</EmptyState>
      </div>
    );
  }

  return <UsersConsole />;
}

function UsersConsole() {
  const { data: users = [], isLoading } = useUsers();
  const { data: me } = useMe();
  const orgs = orgsFromMe(me);

  const [showNew, setShowNew] = useState(false);
  const [link, setLink] = useState<{ user: SetPasswordLink["user"]; url: string } | null>(null);

  if (isLoading) {
    return <PageLoading />;
  }

  return (
    <div className="space-y-6">
      <PageHeader
        align="start"
        title="Users"
        subtitle="Dashboard accounts, instance admins, and org memberships."
        actions={
          <Button onClick={() => setShowNew(true)}>
            <Plus className="h-4 w-4 mr-2" /> New User
          </Button>
        }
      />

      {users.length === 0 ? (
        <EmptyState>No users.</EmptyState>
      ) : (
        <div className="space-y-2">
          {users.map((u) => (
            <UserCard
              key={u.id}
              user={u}
              orgs={orgs.map((o) => ({ id: o.id, name: o.name }))}
              onLink={setLink}
            />
          ))}
        </div>
      )}

      <NewUserDialog
        open={showNew}
        onOpenChange={setShowNew}
        orgs={orgs.map((o) => ({ id: o.id, name: o.name }))}
        onLink={setLink}
      />
      <LinkDialog link={link} onOpenChange={(o) => !o && setLink(null)} />
    </div>
  );
}

function UserCard({
  user,
  orgs,
  onLink,
}: {
  user: UserRow;
  orgs: { id: string; name: string }[];
  onLink: (l: { user: SetPasswordLink["user"]; url: string }) => void;
}) {
  const updateUser = useUpdateUser();
  const deleteUser = useDeleteUser();
  const setPasswordLink = useSetPasswordLink();
  const addMembership = useAddMembership();
  const removeMembership = useRemoveMembership();

  const [confirmDelete, setConfirmDelete] = useState(false);
  const [addRole, setAddRole] = useState<"editor" | "viewer">("editor");
  const [addOrgId, setAddOrgId] = useState("");

  const isAdmin = !!user.is_instance_admin;

  // Orgs the user isn't already a member of (for the "add membership" picker).
  const memberOrgIds = new Set(user.memberships.map((m) => m.org_id));
  const available = orgs.filter((o) => !memberOrgIds.has(o.id));

  async function generateLink() {
    const res = await setPasswordLink.mutateAsync(user.id);
    onLink({ user: res.user, url: res.url });
  }

  async function handleAddMembership() {
    if (!addOrgId) return;
    await addMembership.mutateAsync({ orgId: addOrgId, userId: user.id, role: addRole });
    setAddOrgId("");
  }

  return (
    <div className="rounded-lg border p-3 space-y-3">
      <div className="flex items-start gap-3">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-muted">
          {isAdmin ? (
            <Shield className="h-4 w-4 text-muted-foreground" />
          ) : (
            <UserIcon className="h-4 w-4 text-muted-foreground" />
          )}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-medium">{user.display_name}</span>
            {isAdmin && <Badge variant="secondary">Instance admin</Badge>}
            {user.pending && (
              <Badge variant="outline" className="text-amber-600 dark:text-amber-400 border-amber-500/40">
                Pending — link not used
              </Badge>
            )}
          </div>
          <div className="text-xs text-muted-foreground">{user.email}</div>
        </div>
        <div className="flex items-center gap-1.5">
          <Button
            size="sm"
            variant="outline"
            onClick={() => updateUser.mutate({ id: user.id, isInstanceAdmin: !isAdmin })}
            disabled={updateUser.isPending}
            title={isAdmin ? "Revoke instance admin" : "Make instance admin"}
          >
            <Shield className="h-3.5 w-3.5 mr-1.5" />
            {isAdmin ? "Revoke admin" : "Make admin"}
          </Button>
          <Button size="sm" variant="outline" onClick={generateLink} disabled={setPasswordLink.isPending}>
            <Link2 className="h-3.5 w-3.5 mr-1.5" />
            {user.pending ? "Set-password link" : "Reset link"}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="text-destructive hover:text-destructive"
            onClick={() => setConfirmDelete(true)}
            title="Delete user"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      {/* Memberships — instance admins span all orgs, so we hide the per-org controls for them. */}
      {isAdmin ? (
        <div className="text-xs text-muted-foreground pl-11">
          Access to all orgs (instance admin).
        </div>
      ) : (
        <div className="pl-11 space-y-2">
          {user.memberships.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {user.memberships.map((m) => (
                <span
                  key={m.org_id}
                  className="inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-xs"
                >
                  <span className="font-medium">{m.org_name}</span>
                  <span className="text-muted-foreground">{m.role}</span>
                  <button
                    type="button"
                    className="text-muted-foreground hover:text-destructive"
                    onClick={() =>
                      removeMembership.mutate({ orgId: m.org_id, userId: user.id })
                    }
                    title="Remove from org"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </span>
              ))}
            </div>
          )}
          {available.length > 0 && (
            <div className="flex items-center gap-1.5">
              <select
                value={addOrgId}
                onChange={(e) => setAddOrgId(e.target.value)}
                className="flex h-8 rounded-md border border-input bg-transparent px-2 text-xs shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                <option value="">Add to org…</option>
                {available.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.name}
                  </option>
                ))}
              </select>
              <select
                value={addRole}
                onChange={(e) => setAddRole(e.target.value as "editor" | "viewer")}
                className="flex h-8 rounded-md border border-input bg-transparent px-2 text-xs shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                <option value="editor">editor</option>
                <option value="viewer">viewer</option>
              </select>
              <Button
                size="sm"
                variant="outline"
                onClick={handleAddMembership}
                disabled={!addOrgId || addMembership.isPending}
              >
                Add
              </Button>
            </div>
          )}
        </div>
      )}

      <Dialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete user</DialogTitle>
            <DialogDescription>
              Delete {user.display_name} ({user.email})? This removes their account and memberships.
              This can&apos;t be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirmDelete(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={async () => {
                await deleteUser.mutateAsync(user.id);
                setConfirmDelete(false);
              }}
              disabled={deleteUser.isPending}
            >
              {deleteUser.isPending ? "Deleting..." : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function NewUserDialog({
  open,
  onOpenChange,
  orgs,
  onLink,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  orgs: { id: string; name: string }[];
  onLink: (l: { user: SetPasswordLink["user"]; url: string }) => void;
}) {
  const createUser = useCreateUser();
  const setPasswordLink = useSetPasswordLink();
  const addMembership = useAddMembership();
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [isAdmin, setIsAdmin] = useState(false);
  const [orgId, setOrgId] = useState("");
  const [role, setRole] = useState<"editor" | "viewer">("editor");

  function reset() {
    setEmail("");
    setDisplayName("");
    setIsAdmin(false);
    setOrgId("");
    setRole("editor");
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!email.trim()) return;
    const created = await createUser.mutateAsync({
      email: email.trim(),
      displayName: displayName.trim(),
      isInstanceAdmin: isAdmin,
    });
    // Non-admins get all access from org memberships, so grant the first one
    // here if chosen — otherwise they'd log in to an empty app. Admins skip
    // this (they see every org regardless).
    if (!isAdmin && orgId) {
      await addMembership.mutateAsync({ orgId, userId: created.id, role });
    }
    // Immediately mint a set-password link so the admin can hand it over.
    const linkRes = await setPasswordLink.mutateAsync(created.id);
    reset();
    onOpenChange(false);
    onLink({ user: linkRes.user, url: linkRes.url });
  }

  const busy = createUser.isPending || addMembership.isPending || setPasswordLink.isPending;

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) reset(); onOpenChange(o); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New User</DialogTitle>
          <DialogDescription>
            Creates the account with no password. You&apos;ll get a one-time set-password link to hand over.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleCreate} className="space-y-4">
          <div className="space-y-2">
            <Label>Email</Label>
            <Input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="person@example.com"
              autoFocus
              required
            />
          </div>
          <div className="space-y-2">
            <Label>Display name</Label>
            <Input
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="Jane Doe"
            />
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={isAdmin}
              onChange={(e) => setIsAdmin(e.target.checked)}
              className="h-4 w-4 rounded border-input"
            />
            Instance admin (full access to every org)
          </label>
          {!isAdmin && (
            <div className="space-y-2">
              <Label>Organization</Label>
              {orgs.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  No organizations yet. Create one first — a non-admin user has no access until
                  they belong to an org.
                </p>
              ) : (
                <>
                  <div className="flex items-center gap-2">
                    <select
                      value={orgId}
                      onChange={(e) => setOrgId(e.target.value)}
                      className="flex h-9 flex-1 rounded-md border border-input bg-transparent px-3 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                    >
                      <option value="">Select an organization…</option>
                      {orgs.map((o) => (
                        <option key={o.id} value={o.id}>
                          {o.name}
                        </option>
                      ))}
                    </select>
                    <select
                      value={role}
                      onChange={(e) => setRole(e.target.value as "editor" | "viewer")}
                      disabled={!orgId}
                      className="flex h-9 rounded-md border border-input bg-transparent px-3 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50"
                    >
                      <option value="editor">editor</option>
                      <option value="viewer">viewer</option>
                    </select>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    A non-admin user has no access until they belong to an org. You can add more
                    later from the user&apos;s row.
                  </p>
                </>
              )}
            </div>
          )}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? "Creating..." : "Create user"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function LinkDialog({
  link,
  onOpenChange,
}: {
  link: { user: SetPasswordLink["user"]; url: string } | null;
  onOpenChange: (o: boolean) => void;
}) {
  const [copied, setCopied] = useState(false);

  function copy() {
    if (!link) return;
    navigator.clipboard.writeText(link.url);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <Dialog open={!!link} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Set-password link</DialogTitle>
          <DialogDescription>
            Send this single-use link to{" "}
            <span className="font-medium">{link?.user.email}</span>{" "}
            however you normally reach them — chat, email, or in person. It expires
            in 24 hours and can only be used once. It won&apos;t be shown again.
          </DialogDescription>
        </DialogHeader>
        <div className="flex items-center gap-2">
          <Input readOnly value={link?.url ?? ""} className="font-mono text-xs" />
          <Button variant="outline" onClick={copy}>
            {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
          </Button>
        </div>
        <DialogFooter>
          <Button onClick={() => onOpenChange(false)}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
