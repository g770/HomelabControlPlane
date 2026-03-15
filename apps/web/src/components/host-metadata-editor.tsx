/*
 * Copyright (c) 2026 Homelab Control Plane contributors
 * SPDX-License-Identifier: MIT
 *
 * This component module renders the host metadata editor UI behavior.
 */
import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';
import { normalizeHostTags, parseAndValidateHostTags, type HostType } from '@/lib/host-metadata';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';

type HostMetadataResponse = {
  hostId: string;
  hostName: string;
  tags: string[];
  hostType: HostType;
  updatedAt: string;
};

type HostMetadataEditorProps = {
  hostId: string;
  hostName: string;
  initialTags: string[];
  initialHostType: HostType;
  onSaved?: (response: HostMetadataResponse) => void;
};

/**
 * Renders the host metadata editor view.
 */
export function HostMetadataEditor({
  hostId,
  hostName,
  initialTags,
  initialHostType,
  onSaved,
}: HostMetadataEditorProps) {
  const queryClient = useQueryClient();
  const [tagInput, setTagInput] = useState(initialTags.join(', '));
  const [hostType, setHostType] = useState<HostType>(initialHostType);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [savedTags, setSavedTags] = useState(normalizeTags(initialTags));
  const [savedHostType, setSavedHostType] = useState<HostType>(initialHostType);

  useEffect(() => {
    const normalized = normalizeTags(initialTags);
    setTagInput(normalized.join(', '));
    setHostType(initialHostType);
    setSavedTags(normalized);
    setSavedHostType(initialHostType);
    setNotice(null);
    setError(null);
  }, [initialHostType, initialTags, hostId]);

  const saveMutation = useMutation({
    mutationFn: async (input: { tags: string[]; hostType: HostType }) =>
      apiFetch<HostMetadataResponse>(`/api/hosts/${hostId}/metadata`, {
        method: 'PUT',
        body: JSON.stringify({
          confirm: true,
          tags: input.tags,
          hostType: input.hostType,
        }),
      }),
    onSuccess: async (response) => {
      setSavedTags(response.tags);
      setSavedHostType(response.hostType);
      setTagInput(response.tags.join(', '));
      setHostType(response.hostType);
      setError(null);
      setNotice(`Saved metadata for ${response.hostName}.`);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['hosts'] }),
        queryClient.invalidateQueries({ queryKey: ['host', hostId] }),
      ]);
      onSaved?.(response);
    },
    onError: (caught) => {
      const message = caught instanceof Error ? caught.message : 'Failed to save host metadata.';
      setNotice(null);
      setError(message);
    },
  });

  const draftTags = useMemo(() => normalizeTags(tagInput.split(',')), [tagInput]);
  const isDirty =
    hostType !== savedHostType ||
    draftTags.length !== savedTags.length ||
    draftTags.some((tag, index) => tag !== savedTags[index]);

  /**
   * Implements save.
   */
  const save = () => {
    setNotice(null);
    setError(null);

    let parsedTags: string[];
    try {
      parsedTags = parseAndValidateTags(tagInput);
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : 'Invalid host tags.';
      setError(message);
      return;
    }

    saveMutation.mutate({
      tags: parsedTags,
      hostType,
    });
  };

  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <div className="text-xs font-medium text-muted-foreground">Tags (comma-separated)</div>
        <Input
          value={tagInput}
          onChange={(event) => setTagInput(event.target.value)}
          placeholder="edge, proxmox, rack-1"
        />
      </div>

      <div className="space-y-1">
        <div className="text-xs font-medium text-muted-foreground">Host Type</div>
        <Select value={hostType} onChange={(event) => setHostType(event.target.value as HostType)}>
          <option value="MACHINE">Machine</option>
          <option value="CONTAINER">Container</option>
        </Select>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" onClick={save} disabled={!isDirty || saveMutation.isPending}>
          {saveMutation.isPending ? 'Saving...' : 'Save Metadata'}
        </Button>
        <div className="text-xs text-muted-foreground">Editing metadata for {hostName}</div>
      </div>

      {notice && <div className="text-xs text-muted-foreground">{notice}</div>}
      {error && <div className="text-xs text-rose-400">{error}</div>}
    </div>
  );
}

/**
 * Parses and validate tags.
 */
function parseAndValidateTags(input: string) {
  return parseAndValidateHostTags(input);
}

/**
 * Implements normalize tags.
 */
function normalizeTags(tags: string[]) {
  return normalizeHostTags(tags);
}
