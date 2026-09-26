from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

# =============================================================================
# Module Overview
# =============================================================================
# The shapes of a threat model. `SystemMap` is the data flow diagram: nodes,
# flows and trust boundaries. `ThreatAnalysis` is the threats and attack paths
# found on a confirmed map. Each class is also the JSON Schema a language model
# fills, so field descriptions double as instructions to the model.

ElementKind = Literal["external", "process", "store"]
Stride = Literal["S", "T", "R", "I", "D", "E"]
Severity = Literal["critical", "high", "medium", "low"]
GradeVerdict = Literal["solid", "partial", "missed"]


class ModelOutput(BaseModel):
    """Base for shapes a language model fills: every key required, unknown keys rejected."""

    # Strict structured output (OpenAI `strict: true`) rejects optional keys and needs
    # `additionalProperties: false`, so absent values are `None`, never a missing key.
    model_config = ConfigDict(extra="forbid")


# =============================================================================
# Data flow map
# =============================================================================


class Boundary(ModelOutput):
    """A trust boundary: a zone where everything runs with one level of trust."""

    id: str = Field(description="Short lowercase slug such as `cloud` or `browser`")
    label: str = Field(description="Name of the zone, 1 to 4 words")


class Node(ModelOutput):
    """An element of the map: an external entity, a process or a data store."""

    id: str = Field(description="Short lowercase slug, unique across every node and flow")
    label: str = Field(description="The name a developer on the team would use, 1 to 4 words")
    kind: ElementKind = Field(
        description="external: people or systems the team does not run. process: code the team runs. "
        "store: where data rests"
    )
    tech: str | None = Field(description="Product or framework name, such as `Postgres` or `FastAPI`, or null")
    boundary: str | None = Field(
        description="Id of the trust boundary it runs in, or null for people and vendor systems outside every boundary"
    )
    ai: bool = Field(description="True when it is, or calls, a language model or an agent")
    sensitive: bool = Field(description="True for stores holding credentials, personal, financial or regulated data")
    evidence: str = Field(
        description="A quote of 12 words or fewer from the material, a file path, or `inferred: <reason>`"
    )


class Flow(ModelOutput):
    """Data moving from one node to another."""

    id: str = Field(description="f1, f2, ... unique across every node and flow")
    source: str = Field(description="Id of the node the data leaves")
    target: str = Field(description="Id of the node the data reaches")
    label: str = Field(description="What happens, 1 to 4 words")
    data: str | None = Field(description="What the flow carries, naming sensitive data plainly, or null")
    evidence: str | None = Field(description="A short quote, a file path or `inferred: <reason>`, or null")


class SystemMap(ModelOutput):
    """A data flow diagram of one system."""

    name: str = Field(description="Name of the system")
    summary: str = Field(description="One sentence on what the system does and for whom")
    boundaries: list[Boundary]
    nodes: list[Node]
    flows: list[Flow]
    assumptions: list[str] = Field(description="2 to 5 short sentences on what was assumed or unclear")


# =============================================================================
# Threats
# =============================================================================


class Threat(ModelOutput):
    """One threat, pinned to one node or flow."""

    id: str = Field(description="T1, T2, ... from most to least severe")
    element: str = Field(description="Exactly one node or flow id from the map, where the threat happens")
    stride: Stride
    severity: Severity
    title: str = Field(description="Under 60 characters")
    summary: str = Field(description="One plain sentence that a non-specialist understands")
    statement: str = Field(
        description="`<threat source> <prerequisites> can <threat action>, which leads to <threat impact>, "
        "resulting in reduced <confidentiality|integrity|availability> of <impacted assets>.`"
    )
    impact: str = Field(description="What the business loses, in one sentence")
    fixes: list[str] = Field(description="1 to 3 concrete mitigations an engineer can start today")
    refs: list[str] = Field(
        description="Catalog ids such as `CWE-639` or `OWASP LLM01:2025`; an empty list rather than a guess"
    )
    evidence: str = Field(description="What in the material supports the threat, or `inferred: <reason>`")


class AttackPath(ModelOutput):
    """A route an attacker takes from an entry point to an impact."""

    id: str = Field(description="P1, P2, ...")
    title: str
    severity: Severity
    steps: list[str] = Field(description="Node ids in order, from the entry point to the impact")
    threats: list[str] = Field(description="Threat ids along the way")
    story: str = Field(description="1 or 2 sentences")


class ThreatAnalysis(ModelOutput):
    """The threats and attack paths found on a confirmed map."""

    verdict: str = Field(description="1 or 2 sentences on what to fix first")
    threats: list[Threat]
    paths: list[AttackPath]


# =============================================================================
# Questions about a finished model
# =============================================================================


class Answer(ModelOutput):
    """A reply to a question about one threat model."""

    answer: str = Field(description="1 to 3 sentences naming components, flows and threat ids")
    highlight: list[str] = Field(description="Node, flow and threat ids the reader should look at")


class OpenGrade(ModelOutput):
    """A judgment of a developer's own-words answer to a quiz question."""

    verdict: GradeVerdict = Field(
        description="solid: names the path and the harm. partial: names one of the two. missed: names neither"
    )
    feedback: str = Field(
        description="2 or 3 sentences to the developer: what they got right, then what they missed, "
        "naming components, flows and threat ids"
    )
    highlight: list[str] = Field(description="Node, flow and threat ids the developer should look at")
