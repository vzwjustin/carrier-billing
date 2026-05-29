'use client';

import * as React from 'react';

import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';

const MAX_BYTES = 25 * 1024 * 1024; // 25 MB
const PDF_MIME = 'application/pdf';
const ACCEPT_ATTR = `${PDF_MIME},.pdf,.edi,.x12,.811,.txt`;
const ACCEPTED_EXTENSIONS = ['.pdf', '.edi', '.x12', '.811', '.txt'] as const;

export interface DropzoneProps {
  onFile: (file: File | null) => void;
  disabled?: boolean;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function hasAcceptedExtension(name: string): boolean {
  const lower = name.toLowerCase();
  return ACCEPTED_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

function validate(file: File): string | null {
  const isPdfMime = file.type === PDF_MIME;
  if (!isPdfMime && !hasAcceptedExtension(file.name)) {
    return 'Only PDF or EDI 811 files are accepted.';
  }
  if (file.size > MAX_BYTES) {
    return `File is too large. Maximum size is ${formatBytes(MAX_BYTES)}.`;
  }
  if (file.size === 0) {
    return 'File appears to be empty.';
  }
  return null;
}

export function Dropzone({ onFile, disabled = false }: DropzoneProps): React.JSX.Element {
  const [staged, setStaged] = React.useState<File | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [isDragging, setIsDragging] = React.useState(false);
  const inputRef = React.useRef<HTMLInputElement>(null);

  const accept = React.useCallback(
    (file: File | undefined) => {
      if (!file) return;
      const err = validate(file);
      if (err) {
        setError(err);
        setStaged(null);
        onFile(null);
        return;
      }
      setError(null);
      setStaged(file);
      onFile(file);
    },
    [onFile],
  );

  const handleDrop = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    setIsDragging(false);
    if (disabled) return;
    const file = event.dataTransfer.files?.[0];
    accept(file);
  };

  const handleDragOver = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    if (disabled) return;
    setIsDragging(true);
  };

  const handleDragLeave = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    setIsDragging(false);
  };

  const handleSelect = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    accept(file);
    // Allow selecting the same file again later.
    event.target.value = '';
  };

  const handleRemove = () => {
    setStaged(null);
    setError(null);
    onFile(null);
  };

  const openPicker = () => {
    if (disabled) return;
    inputRef.current?.click();
  };

  return (
    <div className="space-y-3">
      <div
        role="button"
        tabIndex={disabled ? -1 : 0}
        aria-disabled={disabled}
        onClick={openPicker}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            openPicker();
          }
        }}
        onDrop={handleDrop}
        onDragOver={handleDragOver}
        onDragEnter={handleDragOver}
        onDragLeave={handleDragLeave}
        className={cn(
          'flex w-full cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed px-6 py-12 text-center transition-colors',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neutral-900 focus-visible:ring-offset-2',
          isDragging
            ? 'border-neutral-900 bg-neutral-100'
            : 'border-neutral-300 bg-white hover:bg-neutral-50',
          disabled && 'cursor-not-allowed opacity-60',
        )}
      >
        <svg
          aria-hidden="true"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          className={cn(
            'mb-3 h-10 w-10',
            isDragging ? 'text-neutral-900' : 'text-neutral-400',
          )}
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M9 8.25H7.5a2.25 2.25 0 0 0-2.25 2.25v9a2.25 2.25 0 0 0 2.25 2.25h9a2.25 2.25 0 0 0 2.25-2.25v-9a2.25 2.25 0 0 0-2.25-2.25H15M9 12l3-3m0 0 3 3m-3-3v12"
          />
        </svg>
        <p className="text-sm font-medium text-neutral-900">
          Drag and drop your bill here
        </p>
        <p className="mt-1 text-xs text-neutral-500">
          or click to choose a file. PDF or EDI 811 (.edi, .x12, .811, .txt), up to 25 MB.
        </p>
        <input
          ref={inputRef}
          type="file"
          accept={ACCEPT_ATTR}
          className="hidden"
          onChange={handleSelect}
          disabled={disabled}
        />
      </div>

      {staged ? (
        <div className="flex items-center justify-between rounded-md border border-neutral-200 bg-white px-3 py-2">
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-neutral-900">
              {staged.name}
            </p>
            <p className="text-xs text-neutral-500">{formatBytes(staged.size)}</p>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={handleRemove}
            disabled={disabled}
          >
            Remove
          </Button>
        </div>
      ) : null}

      {error ? (
        <p role="alert" className="text-sm text-red-600">
          {error}
        </p>
      ) : null}
    </div>
  );
}
