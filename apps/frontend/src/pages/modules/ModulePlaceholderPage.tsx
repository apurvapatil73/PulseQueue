import React from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, Construction } from 'lucide-react';
import { useOrganisation } from '../../contexts/OrganisationContext';
import { PageContainer } from '../../components/layout/PageContainer';
import { Button } from '../../components/ui/Button';
import { Card, CardContent } from '../../components/ui/Card';
import { StatusBadge } from '../../components/ui/StatusBadge';

export interface ModulePlaceholderPageProps {
  title: string;
  description: string;
  icon: React.ReactNode;
  plannedCapabilities: string[];
  milestoneLabel: string;
}

export function ModulePlaceholderPage({
  title,
  description,
  icon,
  plannedCapabilities,
  milestoneLabel,
}: ModulePlaceholderPageProps) {
  const { activeOrganisation } = useOrganisation();

  return (
    <PageContainer
      title={title}
      description={description}
      actions={
        <Link to="/dashboard">
          <Button variant="secondary" size="sm" leftIcon={<ArrowLeft className="h-3.5 w-3.5" />}>
            Back to Overview
          </Button>
        </Link>
      }
    >
      <Card>
        <CardContent className="py-10">
          <div className="mx-auto max-w-lg text-center">
            <div className="mx-auto flex h-11 w-11 items-center justify-center rounded-xl border border-border-strong bg-surface-elevated text-sky-400">
              {icon}
            </div>
            <div className="mt-3 flex items-center justify-center gap-2">
              <StatusBadge status="ACTIVE" tone="sky" label={milestoneLabel} />
              {activeOrganisation && (
                <StatusBadge status="ACTIVE" tone="slate" label={activeOrganisation.name} />
              )}
            </div>
            <h2 className="mt-3 text-base font-semibold text-slate-100">{title} Module Scaffold</h2>
            <p className="mt-1.5 text-xs text-slate-400">
              Routing, authentication, organisation context, and API integration foundations are
              wired. Full interactive workflows for this module will be delivered in upcoming Step 6
              milestones.
            </p>

            <div className="mt-6 rounded-lg border border-border-subtle bg-canvas/70 p-4 text-left">
              <div className="mb-2 flex items-center gap-2 text-xs font-medium text-slate-300">
                <Construction className="h-3.5 w-3.5 text-sky-400" />
                Planned capabilities connected to existing backend APIs
              </div>
              <ul className="space-y-1.5 text-xs text-slate-400 list-disc pl-5">
                {plannedCapabilities.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </div>
          </div>
        </CardContent>
      </Card>
    </PageContainer>
  );
}
