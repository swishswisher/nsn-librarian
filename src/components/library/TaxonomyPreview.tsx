import { NsnCard } from "@/components/library/NsnCard";
import { nsnTaxonomy, type NsnTaxonomyNode } from "@/config/nsn-taxonomy";

function TaxonomyChildren({ nodes }: { nodes: NsnTaxonomyNode[] }) {
  return (
    <ul className="mt-3 grid gap-2 pl-4">
      {nodes.map((node) => (
        <li className="border-l border-[var(--nsn-border)] pl-3" key={node.slug}>
          <span className="text-sm text-[var(--nsn-slate)]">{node.name}</span>
          {node.children ? <TaxonomyChildren nodes={node.children} /> : null}
        </li>
      ))}
    </ul>
  );
}

export function TaxonomyPreview() {
  return (
    <section aria-labelledby="taxonomy-preview-heading">
      <div className="mb-4">
        <h2
          className="nsn-display text-2xl text-[var(--nsn-navy)]"
          id="taxonomy-preview-heading"
        >
          Library Map
        </h2>
        <p className="mt-1 text-sm text-[var(--nsn-slate)]">
          A calm starting map for how the Librarian may understand approved
          library areas.
        </p>
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        {nsnTaxonomy.map((node) => (
          <NsnCard key={node.slug}>
            <h3 className="font-semibold text-[var(--nsn-navy)]">
              {node.name}
            </h3>
            {node.children ? <TaxonomyChildren nodes={node.children} /> : null}
          </NsnCard>
        ))}
      </div>
    </section>
  );
}
