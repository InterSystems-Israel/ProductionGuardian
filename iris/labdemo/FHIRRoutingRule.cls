/// Routing rule for FHIRTransform — sends all messages to CloudAPI.
/// In MVP 1 there is no actual DTL transform; messages pass through to
/// CloudAPI for the purpose of generating metric activity.
/// A real DTL transform would be added in a subsequent sprint.
Class ProductionGuardian.LabDemo.FHIRRoutingRule Extends Ens.Rule.Definition
{

Parameter RuleAssistClass = "EnsLib.MsgRouter.RuleAssist";

XData RuleDefinition [ XMLNamespace = "http://www.intersystems.com/rule" ]
{
<ruleDefinition alias="" context="EnsLib.MsgRouter.RoutingEngine" production="ProductionGuardian.LabDemo.Production">
  <ruleSet name="" effectiveBegin="" effectiveEnd="">

    <rule name="Forward all to CloudAPI">
      <when condition="1">
        <send transform="" target="CloudAPI"/>
        <return/>
      </when>
    </rule>

  </ruleSet>
</ruleDefinition>
}

}
